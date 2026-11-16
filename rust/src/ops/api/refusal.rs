use std::{borrow::Cow, fmt::Display};

use aide::{
	OperationInput, OperationOutput,
	generate::GenContext,
	openapi::{MediaType, Operation, ReferenceOr, Response, SchemaObject, StatusCode as Status},
};
use axum::{
	Json,
	body::Bytes,
	extract::{FromRequest, FromRequestParts, OptionalFromRequest, Path, Query, Request},
	http::{StatusCode, request::Parts},
	response::IntoResponse,
};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

/// A service's closed set of refusals: each a word (its serde name) a client acts on, and the
/// one status it is answered with.
pub trait ErrorCode: Copy + Serialize + strum::VariantArray + 'static {
	fn status(self) -> StatusCode;
}

/// How the service's codes refuse what `E` says went wrong: `?` turns an `E` into a [`Refusal`].
pub trait Refuses<E>: ErrorCode {
	fn refusal(e: E) -> Refusal<Self>;
}

/// A refused request, answered `{code, error}` with `code`'s status; `error` is for a person.
#[derive(Debug, Serialize)]
pub struct Refusal<C> {
	code: C,
	error: String,
}

impl<C: ErrorCode> Refusal<C> {
	pub fn new(code: C, error: impl Into<String>) -> Self {
		Self { code, error: error.into() }
	}
}

// `Refusal` implements no `Display`, so this never overlaps `From<T> for T`.
impl<C: Refuses<E>, E: Display> From<E> for Refusal<C> {
	fn from(e: E) -> Self {
		C::refusal(e)
	}
}

/// What [`Body`], [`Params`] and [`Ids`] refuse a request with.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, strum::VariantArray)]
#[serde(rename_all = "snake_case")]
pub enum Malformed {
	BadRequest,
	TooLarge,
	/// A path's id that is not one names nothing.
	NotFound,
}

impl ErrorCode for Malformed {
	fn status(self) -> StatusCode {
		match self {
			Self::BadRequest => StatusCode::BAD_REQUEST,
			Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
			Self::NotFound => StatusCode::NOT_FOUND,
		}
	}
}

/// A JSON body. Optional (`Option<Body<T>>`), an empty body or `null` is none, and the content
/// type is not asked for.
pub struct Body<T>(pub T);

/// A query string.
pub struct Params<T>(pub T);

/// The ids in a path, by their names in it; one that is not an id at all names nothing: a 404.
pub struct Ids<T>(pub T);

pub(crate) fn word<C: ErrorCode>(code: C) -> String {
	match serde_json::to_value(code) {
		Ok(Value::String(w)) => w,
		other => panic!("an ErrorCode serializes as a word, not {other:?}"),
	}
}

/// `codes` among what `op` answers: in its `x-errors`, and an `Error` answer for each status.
pub(crate) fn document<C: ErrorCode>(ctx: &mut GenContext, op: &mut Operation, codes: &[C]) {
	let errors = op.extensions.entry("x-errors".into()).or_insert_with(|| Value::Object(Default::default()));
	let errors = errors.as_object_mut().expect("x-errors is written here only, as an object");
	let mut statuses = Vec::new();
	for &code in codes {
		let (word, status) = (word(code), code.status().as_u16());
		match errors.get(&word) {
			Some(held) => assert_eq!(held.as_u64(), Some(u64::from(status)), "{word} is answered with one status"),
			None => {
				errors.insert(word, status.into());
			}
		}
		if !statuses.contains(&status) {
			statuses.push(status);
		}
	}
	let described: Vec<(u16, String)> = statuses
		.into_iter()
		.map(|status| {
			let words: Vec<String> = errors.iter().filter(|(_, s)| s.as_u64() == Some(u64::from(status))).map(|(w, _)| format!("`{w}`")).collect();
			(status, words.join(", "))
		})
		.collect();
	let schema = ctx.schema.subschema_for::<Refusal<Malformed>>();
	let responses = op.responses.get_or_insert_with(Default::default);
	for (status, description) in described {
		let content = [(
			"application/json".to_owned(),
			MediaType {
				schema: Some(SchemaObject {
					json_schema: schema.clone(),
					example: None,
					external_docs: None,
				}),
				..MediaType::default()
			},
		)];
		responses.responses.insert(
			Status::Code(status),
			ReferenceOr::Item(Response {
				description,
				content: content.into_iter().collect(),
				..Response::default()
			}),
		);
	}
}

impl<C: ErrorCode> IntoResponse for Refusal<C> {
	fn into_response(self) -> axum::response::Response {
		(self.code.status(), Json(self)).into_response()
	}
}

impl<C: ErrorCode> OperationOutput for Refusal<C> {
	type Inner = Self;

	fn inferred_responses(ctx: &mut GenContext, op: &mut Operation) -> Vec<(Option<Status>, Response)> {
		document(ctx, op, C::VARIANTS);
		Vec::new()
	}
}

/// Every `C` is one schema, `Error`; its `code` is the document's `ErrorCode`, every word any
/// operation answers.
impl<C> JsonSchema for Refusal<C> {
	fn schema_name() -> Cow<'static, str> {
		"Error".into()
	}

	fn schema_id() -> Cow<'static, str> {
		"ev_lib::api::Refusal".into()
	}

	fn json_schema(_: &mut SchemaGenerator) -> Schema {
		json_schema!({
			"type": "object",
			"description": "Why the request was refused.",
			"required": ["code", "error"],
			"properties": {
				"code": { "$ref": "#/components/schemas/ErrorCode" },
				"error": { "type": "string", "description": "For a person." }
			}
		})
	}
}

fn malformed(status: StatusCode, text: String) -> Refusal<Malformed> {
	match status {
		StatusCode::PAYLOAD_TOO_LARGE => Refusal::new(Malformed::TooLarge, text),
		_ => Refusal::new(Malformed::BadRequest, text),
	}
}

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for Body<T> {
	type Rejection = Refusal<Malformed>;

	async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
		<Json<T> as FromRequest<S>>::from_request(req, state)
			.await
			.map(|Json(v)| Self(v))
			.map_err(|e| malformed(e.status(), e.body_text()))
	}
}

impl<T: DeserializeOwned, S: Send + Sync> OptionalFromRequest<S> for Body<T> {
	type Rejection = Refusal<Malformed>;

	async fn from_request(req: Request, state: &S) -> Result<Option<Self>, Self::Rejection> {
		let raw = <Bytes as FromRequest<S>>::from_request(req, state).await.map_err(|e| malformed(e.status(), e.body_text()))?;
		if raw.iter().all(u8::is_ascii_whitespace) {
			return Ok(None);
		}
		let v: Option<T> = serde_json::from_slice(&raw).map_err(|e| Refusal::new(Malformed::BadRequest, format!("the body: {e}")))?;
		Ok(v.map(Self))
	}
}

impl<T: JsonSchema> OperationInput for Body<T> {
	fn operation_input(ctx: &mut GenContext, op: &mut Operation) {
		Json::<T>::operation_input(ctx, op);
		document(ctx, op, &[Malformed::BadRequest, Malformed::TooLarge]);
	}
}

impl<T: DeserializeOwned, S: Send + Sync> FromRequestParts<S> for Params<T> {
	type Rejection = Refusal<Malformed>;

	async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
		Query::<T>::from_request_parts(parts, state)
			.await
			.map(|Query(v)| Self(v))
			.map_err(|e| Refusal::new(Malformed::BadRequest, e.body_text()))
	}
}

impl<T: JsonSchema> OperationInput for Params<T> {
	fn operation_input(ctx: &mut GenContext, op: &mut Operation) {
		Query::<T>::operation_input(ctx, op);
		document(ctx, op, &[Malformed::BadRequest]);
	}
}

impl<T: DeserializeOwned + Send, S: Send + Sync> FromRequestParts<S> for Ids<T> {
	type Rejection = Refusal<Malformed>;

	async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
		Path::<T>::from_request_parts(parts, state)
			.await
			.map(|Path(v)| Self(v))
			.map_err(|_| Refusal::new(Malformed::NotFound, "not found"))
	}
}

impl<T: JsonSchema> OperationInput for Ids<T> {
	fn operation_input(ctx: &mut GenContext, op: &mut Operation) {
		Path::<T>::operation_input(ctx, op);
		document(ctx, op, &[Malformed::NotFound]);
	}
}
