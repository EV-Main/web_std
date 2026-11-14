use std::{any::type_name, collections::BTreeSet};

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
pub use schemars::{self, JsonSchema};
use serde::Serialize;
use serde_json::Value;

/// The handlers' `///`, keyed by their paths: what `api_docs!()` includes, `docs::write` writes.
pub type Docs = &'static [(&'static str, &'static str)];

/// The handlers' `///`, as the service's `build.rs` wrote them (`docs::write`).
#[macro_export]
macro_rules! api_docs {
	() => {
		include!(concat!(env!("OUT_DIR"), "/api_docs.rs"))
	};
}

/// What a service gates a route on, as far as the document says it: the permission that opens it.
pub trait Guard {
	fn permission(&self) -> Option<String>;
}

/// One operation: its method and path, the service's gate, and its handler, whose signature is
/// its request and answer.
pub struct Route<S, G> {
	pub method: Method,
	pub path: &'static str,
	pub guard: G,
	/// Answering it costs money the caller is charged for.
	pub spends: bool,
	handler: MethodRouter<S>,
	/// `<crate>::<module>::<fn>`.
	handler_path: &'static str,
	describe: fn(&mut GenContext, &mut Operation),
}

impl<S: Clone + Send + Sync + 'static, G> Route<S, G> {
	pub fn new<H, T, I, O>(method: Method, path: &'static str, guard: G, handler: H) -> Self
	where
		H: Handler<T, S> + OperationHandler<I, O>,
		I: OperationInput,
		O: OperationOutput,
		T: 'static, {
		let filter = MethodFilter::try_from(method.clone()).expect("routes name standard methods");
		let handler_path = type_name::<H>();
		assert!(!handler_path.contains('{'), "{path}: a route's handler is a named fn, its name the operation's id");
		Self {
			method,
			path,
			guard,
			spends: false,
			handler: on(filter, handler),
			handler_path,
			describe: describe::<I, O>,
		}
	}

	pub fn spends(self) -> Self {
		Self { spends: true, ..self }
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
		self.handler_path.rsplit("::").next().expect("rsplit yields at least one item")
	}
}

/// The OpenAPI document of `routes`, served under `base`; `docs` from `api_docs!()`.
///
/// Every route's handler must have a `///`, its first line the summary; ids are unique, and the
/// path's parameters are the ones its extractors take.
pub fn document<S: Clone + Send + Sync + 'static, G: Guard>(title: &str, version: &str, base: &str, routes: &[Route<S, G>], docs: Docs) -> OpenApi {
	let mut paths = Paths::default();
	let mut ids = BTreeSet::new();
	let schemas = in_context(|ctx| {
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
			(route.describe)(ctx, &mut op);
			let answers = op.responses.as_ref().map(|r| r.responses.keys().collect::<Vec<_>>()).unwrap_or_default();
			assert!(
				answers.iter().any(|s| matches!(s, StatusCode::Code(200..=299))),
				"{} {}: the handler's answer is a typed one (Json, Created, NoContent…), not a bare Response or a tuple",
				route.method,
				route.path
			);
			if let Some(permission) = route.guard.permission() {
				op.extensions.insert("x-permission".into(), Value::String(permission));
			}
			if route.spends {
				op.extensions.insert("x-spends".into(), Value::Bool(true));
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
		ctx.schema.take_definitions(true)
	});
	generate::reset_context();
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
		..OpenApi::default()
	}
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

/// `201` and the created resource.
pub struct Created<T>(pub T);

/// `201` a resource made now, `200` the one that stood already.
pub enum Upserted<T> {
	Created(T),
	Existed(T),
}

fn describe<I: OperationInput, O: OperationOutput>(ctx: &mut GenContext, op: &mut Operation) {
	I::operation_input(ctx, op);
	// An extractor's early answer overrides the handler's: the request never reaches it.
	let answers = O::inferred_responses(ctx, op).into_iter().chain(I::inferred_early_responses(ctx, op)).collect::<Vec<_>>();
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
