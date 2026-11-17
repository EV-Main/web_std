use std::{any::type_name, collections::BTreeSet, pin::Pin};

pub use aide::{
	OperationInput, OperationOutput,
	generate::GenContext,
	openapi::{self, OpenApi},
};
use aide::{
	generate::{self, in_context},
	openapi::{Info, Operation, PathItem, Paths, ReferenceOr, Response, Responses, SchemaObject, Server, StatusCode},
	operation::OperationHandler,
};
use axum::{
	Json,
	handler::Handler,
	http::{self, Method},
	response::IntoResponse,
	routing::{MethodFilter, MethodRouter, on},
};
use schemars::SchemaGenerator;
pub use schemars::{self, JsonSchema};
use serde::Serialize;
use serde_json::Value;

use super::{ErrorCode, Refusal};

/// The handlers' `///`, keyed by their paths: what `api_docs!()` includes, `docs::write` writes.
pub type Docs = &'static [(&'static str, &'static str)];

/// The handlers' `///`, as the service's `build.rs` wrote them (`docs::write`).
#[macro_export]
macro_rules! api_docs {
	() => {
		include!(concat!(env!("OUT_DIR"), "/api_docs.rs"))
	};
}

/// What a service gates a route on: the permission that opens it, as the document says, and the
/// check every request passes before its handler, so a route is never mounted without it.
pub trait Guard<S>: Clone + Send + Sync + 'static {
	type Refusal: ErrorCode;

	fn permission(&self) -> Option<&'static str>;

	/// Every code [`Self::admit`] may refuse this route with: its `x-errors`.
	fn refusals(&self) -> Vec<Self::Refusal>;

	fn admit(&self, parts: &mut http::request::Parts, state: &S) -> impl Future<Output = Result<(), Refusal<Self::Refusal>>> + Send;
}

/// One operation: its method and path, the service's gate, and its handler, whose signature is
/// its request and answer.
pub struct Route<S, G> {
	pub method: Method,
	pub path: &'static str,
	pub guard: G,
	handler: MethodRouter<S>,
	/// `<crate>::<module>::<fn>`.
	handler_path: &'static str,
	socket: bool,
	describe: fn(&mut GenContext, &mut SchemaGenerator, &mut Operation),
}

impl<S: Clone + Send + Sync + 'static, G> Route<S, G> {
	pub fn new<H, T, I, O>(method: Method, path: &'static str, guard: G, handler: H) -> Self
	where
		G: Guard<S>,
		H: Handler<T, S> + OperationHandler<I, O>,
		I: OperationInput,
		O: OperationOutput,
		T: 'static, {
		let filter = MethodFilter::try_from(method.clone()).expect("routes name standard methods");
		let handler_path = named::<H>();
		// aide's `WebSocketUpgrade` answers 101
		let socket = in_context(|ctx| {
			let mut op = Operation::default();
			I::operation_input(ctx, &mut op);
			op.responses.is_some_and(|r| r.responses.contains_key(&StatusCode::Code(101)))
		});
		generate::reset_context(); // what the probe defined is no document's
		assert!(!socket || method == Method::GET, "{path}: a socket is opened by a GET");
		Self {
			method,
			path,
			handler: on(filter, Gated { guard: guard.clone(), handler }),
			guard,
			handler_path,
			socket,
			describe: describe::<I, O>,
		}
	}

	/// Layers the handler (a body limit, say): the document stays its signature's.
	pub fn layer(self, f: impl FnOnce(MethodRouter<S>) -> MethodRouter<S>) -> Self {
		Self { handler: f(self.handler), ..self }
	}

	pub fn handler(&self) -> MethodRouter<S> {
		self.handler.clone()
	}

	/// The handler's name: unique in a service's table.
	pub fn id(&self) -> &'static str {
		id(self.handler_path)
	}

	/// Its handler takes `WebSocketUpgrade`: the operation is `x-socket`.
	pub fn socket(&self) -> bool {
		self.socket
	}
}

/// The id of `handler`'s operation, as its route's [`Route::id`].
pub fn op_id<H>(_: H) -> &'static str {
	id(named::<H>())
}

fn named<H>() -> &'static str {
	let path = type_name::<H>();
	assert!(!path.contains('{'), "{path}: an operation's handler is a named fn, its name the operation's id");
	path
}

fn id(handler_path: &'static str) -> &'static str {
	handler_path.rsplit("::").next().expect("rsplit yields at least one item")
}

/// The OpenAPI document of `routes`, served under `base`; `docs` from `api_docs!()`; `views` its
/// `x-views` (`Views::table()`), `None` for a service with no page.
///
/// Every route's handler must have a `///`, its first line the summary; ids are unique, and the
/// path's parameters are the ones its extractors take.
pub fn document<S: Clone + Send + Sync + 'static, G: Guard<S>>(
	title: &str,
	version: &str,
	base: &str,
	routes: &[Route<S, G>],
	docs: Docs,
	views: Option<&crate::ops::views::Table>,
) -> OpenApi {
	let mut paths = Paths::default();
	let mut ids = BTreeSet::new();
	let (asked, answered) = in_context(|ctx| {
		let mut answered = ctx.schema.settings().clone().for_serialize().into_generator();
		for route in routes {
			let id = route.id();
			assert!(ids.insert(id), "two operations are named {id}: rename a handler");
			let doc = docs
				.iter()
				.find(|(path, _)| *path == route.handler_path)
				.unwrap_or_else(|| panic!("{}: an operation's handler has a ///", route.handler_path))
				.1;
			let (summary, description) = doc.split_once("\n\n").map_or((doc, None), |(s, d)| (s, Some(d)));
			let mut op = Operation {
				operation_id: Some(id.to_owned()),
				summary: Some(summary.replace('\n', " ")),
				description: description.map(str::to_owned),
				tags: route.handler_path.split("::").nth(1).filter(|m| *m != id).map(str::to_owned).into_iter().collect(),
				..Operation::default()
			};
			op.extensions.insert("x-errors".into(), Value::Object(Default::default()));
			(route.describe)(ctx, &mut answered, &mut op);
			let answers = op.responses.as_ref().map(|r| r.responses.keys().collect::<Vec<_>>()).unwrap_or_default();
			assert!(
				route.socket || answers.iter().any(|s| matches!(s, StatusCode::Code(200..=299))),
				"{} {}: the handler's answer is a typed one (Json, Created, NoContent…), not a bare Response or a tuple",
				route.method,
				route.path
			);
			if route.socket {
				op.extensions.insert("x-socket".into(), Value::Bool(true));
			}
			super::refusal::document(ctx, &mut op, &route.guard.refusals());
			if let Some(permission) = route.guard.permission() {
				op.extensions.insert("x-permission".into(), permission.into());
			}
			let named: BTreeSet<&str> = route.path.split('/').filter_map(|s| s.strip_prefix('{')?.strip_suffix('}')).collect();
			assert!(named.iter().all(|n| !n.starts_with('*')), "{}: a wildcard is not an operation's path", route.path);
			let taken: BTreeSet<&str> = op
				.parameters
				.iter()
				.filter_map(|p| match p {
					ReferenceOr::Item(openapi::Parameter::Path { parameter_data, .. }) => Some(parameter_data.name.as_str()),
					_ => None,
				})
				.collect();
			assert_eq!(named, taken, "{} {}: the path's parameters are its extractor's", route.method, route.path);
			let item = paths.paths.entry(route.path.to_owned()).or_insert_with(|| ReferenceOr::Item(PathItem::default()));
			let ReferenceOr::Item(item) = item else { unreachable!("only items are inserted") };
			let slot = match route.method {
				Method::GET => &mut item.get,
				Method::POST => &mut item.post,
				Method::PUT => &mut item.put,
				Method::PATCH => &mut item.patch,
				Method::DELETE => &mut item.delete,
				ref m => panic!("{m} {}: not an operation's method", route.path),
			};
			assert!(slot.replace(op).is_none(), "{} {} is routed twice", route.method, route.path);
		}
		(ctx.schema.take_definitions(true), answered.take_definitions(true))
	});
	generate::reset_context();
	let words = error_codes(&paths);
	let (paths, mut schemas) = contracts(paths, asked, answered);
	if !words.is_empty() {
		schemas.insert(
			"ErrorCode".into(),
			serde_json::json!({ "type": "string", "description": "Which refusal, for a client to act on: its status follows from it.", "enum": words }),
		);
	}
	let mut schemas = referenced(&paths, schemas);
	schemas.values_mut().for_each(flat_enums);
	OpenApi {
		info: Info {
			title: title.to_owned(),
			version: version.to_owned(),
			..Info::default()
		},
		servers: vec![Server {
			url: base.to_owned(),
			..Server::default()
		}],
		paths: Some(paths),
		components: Some(openapi::Components {
			schemas: schemas
				.into_iter()
				.map(|(name, schema)| {
					let json_schema = schema.try_into().expect("schemars defines schemas as objects");
					(
						name,
						SchemaObject {
							json_schema,
							example: None,
							external_docs: None,
						},
					)
				})
				.collect(),
			..openapi::Components::default()
		}),
		extensions: views.into_iter().map(|t| ("x-views".to_owned(), serde_json::to_value(t).expect("a table serializes"))).collect(),
		..OpenApi::default()
	}
}

/// A route's handler behind its guard.
#[derive(Clone)]
pub(crate) struct Gated<H, G> {
	pub(crate) guard: G,
	pub(crate) handler: H,
}

impl<H: Handler<T, S>, T: 'static, S: Clone + Send + Sync + 'static, G: Guard<S>> Handler<T, S> for Gated<H, G> {
	type Future = Pin<Box<dyn Future<Output = axum::response::Response> + Send>>;

	fn call(self, req: axum::extract::Request, state: S) -> Self::Future {
		Box::pin(async move {
			let (mut parts, body) = req.into_parts();
			if let Err(refused) = self.guard.admit(&mut parts, &state).await {
				return refused.into_response();
			}
			#[cfg(all(feature = "sqlite", not(target_arch = "wasm32")))]
			if parts.method == Method::GET {
				return crate::ops::sqlite::stamped(self.handler.call(axum::extract::Request::from_parts(parts, body), state)).await;
			}
			self.handler.call(axum::extract::Request::from_parts(parts, body), state).await
		})
	}
}

/// `201` and the created resource.
pub struct Created<T>(pub T);

/// `201` a resource made now, `200` the one that stood already.
pub enum Upserted<T> {
	Created(T),
	Existed(T),
}

/// Every word any operation refuses with, each answered with one status across the document.
fn error_codes(paths: &Paths) -> Vec<String> {
	let mut words = std::collections::BTreeMap::new();
	for (path, item) in &paths.paths {
		let ReferenceOr::Item(item) = item else { unreachable!("only items are inserted") };
		for (method, op) in item.iter() {
			let errors = op.extensions["x-errors"].as_object().expect("document() writes x-errors as an object");
			for (word, status) in errors {
				if let Some(held) = words.insert(word.clone(), status) {
					assert_eq!(held, status, "{method} {path}: {word} is answered with one status in a document");
				}
			}
		}
	}
	words.into_keys().collect()
}

/// One set of definitions from a request's and an answer's: a type whose schema differs between
/// them is `<Name>Input` where a request takes it.
fn contracts(paths: Paths, asked: serde_json::Map<String, Value>, answered: serde_json::Map<String, Value>) -> (Paths, serde_json::Map<String, Value>) {
	let differ: BTreeSet<String> = asked.iter().filter(|(k, v)| answered.get(*k).is_some_and(|a| a != *v)).map(|(k, _)| k.clone()).collect();
	fn input(v: &mut Value, differ: &BTreeSet<String>) {
		match v {
			Value::Object(o) => {
				if let Some(Value::String(r)) = o.get_mut("$ref")
					&& let Some(name) = r.strip_prefix("#/components/schemas/")
					&& differ.contains(name)
				{
					*r = format!("#/components/schemas/{name}Input");
				}
				o.values_mut().for_each(|v| input(v, differ));
			}
			Value::Array(a) => a.iter_mut().for_each(|v| input(v, differ)),
			_ => {}
		}
	}
	let mut paths = serde_json::to_value(paths).expect("paths serialize");
	for op in paths
		.as_object_mut()
		.into_iter()
		.flat_map(|p| p.values_mut())
		.filter_map(Value::as_object_mut)
		.flat_map(|item| item.values_mut())
	{
		for part in ["parameters", "requestBody"] {
			if let Some(v) = op.get_mut(part) {
				input(v, &differ);
			}
		}
	}
	let mut schemas = answered;
	for (name, mut schema) in asked {
		input(&mut schema, &differ);
		let name = if differ.contains(&name) { format!("{name}Input") } else { name };
		schemas.insert(name, schema);
	}
	(serde_json::from_value(paths).expect("paths deserialize as they serialized"), schemas)
}

/// A string enum whose variants carry docs is a `oneOf` of one-value schemas to schemars: one `enum`
/// here, the variants' docs in its description, so a client generator sees the whole word set.
fn flat_enums(schema: &mut Value) {
	match schema {
		Value::Object(o) => {
			let words = o.get("oneOf").and_then(Value::as_array).and_then(|variants| {
				variants
					.iter()
					.map(|v| {
						let v = v.as_object()?;
						let word = match (v.get("const"), v.get("enum").and_then(Value::as_array)) {
							(Some(Value::String(w)), _) => vec![w.clone()],
							(None, Some(ws)) => ws.iter().map(|w| w.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()?,
							_ => return None,
						};
						let known = v.keys().all(|k| matches!(k.as_str(), "const" | "enum" | "type" | "description"));
						known.then(|| (word, v.get("description").and_then(Value::as_str).map(str::to_owned)))
					})
					.collect::<Option<Vec<_>>>()
			});
			match words {
				Some(words) => {
					let docs: Vec<String> = words.iter().filter_map(|(ws, d)| d.as_ref().map(|d| format!("- `{}`: {d}", ws.join("`, `")))).collect();
					let mut description = o.get("description").and_then(Value::as_str).unwrap_or_default().to_owned();
					if !docs.is_empty() {
						description = [description, docs.join("\n")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
					}
					o.remove("oneOf");
					o.insert("type".into(), "string".into());
					o.insert("enum".into(), words.into_iter().flat_map(|(ws, _)| ws).map(Value::String).collect());
					if !description.is_empty() {
						o.insert("description".into(), description.into());
					}
				}
				None => o.values_mut().for_each(flat_enums),
			}
		}
		Value::Array(a) => a.iter_mut().for_each(flat_enums),
		_ => {}
	}
}

/// Only the definitions the operations reach: a path's or a query's parameters are taken apart into
/// the operation, the struct they came from is no schema of the document's.
fn referenced(paths: &Paths, mut definitions: serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
	fn refs(v: &Value, out: &mut Vec<String>) {
		match v {
			Value::Object(o) => {
				if let Some(Value::String(r)) = o.get("$ref")
					&& let Some(name) = r.strip_prefix("#/components/schemas/")
				{
					out.push(name.to_owned());
				}
				o.values().for_each(|v| refs(v, out));
			}
			Value::Array(a) => a.iter().for_each(|v| refs(v, out)),
			_ => {}
		}
	}
	let mut todo = Vec::new();
	refs(&serde_json::to_value(paths).expect("paths serialize"), &mut todo);
	let mut kept = serde_json::Map::new();
	while let Some(name) = todo.pop() {
		if kept.contains_key(&name) {
			continue;
		}
		let schema = definitions.remove(&name).unwrap_or_else(|| panic!("a $ref to {name}, which schemars did not define"));
		refs(&schema, &mut todo);
		kept.insert(name, schema);
	}
	kept.sort_keys();
	kept
}

/// A request's schemas under serde's deserialize contract (an `Option` field may be absent), an
/// answer's under the serialize one (it is always there): `answered` is the latter's generator.
fn describe<I: OperationInput, O: OperationOutput>(ctx: &mut GenContext, answered: &mut SchemaGenerator, op: &mut Operation) {
	I::operation_input(ctx, op);
	std::mem::swap(&mut ctx.schema, answered);
	let answers = O::inferred_responses(ctx, op);
	std::mem::swap(&mut ctx.schema, answered);
	// An extractor's early answer overrides the handler's: the request never reaches it.
	let answers = answers.into_iter().chain(I::inferred_early_responses(ctx, op)).collect::<Vec<_>>();
	let responses = op.responses.get_or_insert_with(Responses::default);
	for (status, answer) in answers {
		match status {
			Some(status) => {
				responses.responses.insert(status, ReferenceOr::Item(answer));
			}
			None => responses.default = Some(ReferenceOr::Item(answer)),
		}
	}
}

impl<T: Serialize> IntoResponse for Created<T> {
	fn into_response(self) -> axum::response::Response {
		(http::StatusCode::CREATED, Json(self.0)).into_response()
	}
}

impl<T: JsonSchema> OperationOutput for Created<T> {
	type Inner = T;

	fn operation_response(ctx: &mut GenContext, op: &mut Operation) -> Option<Response> {
		Json::<T>::operation_response(ctx, op)
	}

	fn inferred_responses(ctx: &mut GenContext, op: &mut Operation) -> Vec<(Option<StatusCode>, Response)> {
		Self::operation_response(ctx, op).map(|r| (Some(StatusCode::Code(201)), r)).into_iter().collect()
	}
}

impl<T: Serialize> IntoResponse for Upserted<T> {
	fn into_response(self) -> axum::response::Response {
		match self {
			Self::Created(t) => Created(t).into_response(),
			Self::Existed(t) => Json(t).into_response(),
		}
	}
}

impl<T: JsonSchema> OperationOutput for Upserted<T> {
	type Inner = T;

	fn operation_response(ctx: &mut GenContext, op: &mut Operation) -> Option<Response> {
		Json::<T>::operation_response(ctx, op)
	}

	fn inferred_responses(ctx: &mut GenContext, op: &mut Operation) -> Vec<(Option<StatusCode>, Response)> {
		Self::operation_response(ctx, op)
			.into_iter()
			.flat_map(|r| [(Some(StatusCode::Code(201)), r.clone()), (Some(StatusCode::Code(200)), r)])
			.collect()
	}
}
