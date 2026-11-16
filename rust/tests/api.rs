//! A service's table as the services write one: its document says what each operation refuses
//! with, its refusals are answered as it says, and its document is served and generated from.

use axum::{
	Json, Router,
	body::{Body as Payload, to_bytes},
	extract::ws::WebSocketUpgrade,
	http::{Method, Request, StatusCode, header, request::Parts},
	response::Response,
};
use ev_lib::api::{Body, ErrorCode, Guard, Ids, JsonSchema, Params, Refusal, Refuses, Route, document, op_id, rust_client, serve};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tower::ServiceExt;

#[derive(Clone, Copy, Debug, Serialize, strum::VariantArray)]
#[serde(rename_all = "snake_case")]
enum Code {
	BadRequest,
	NotFound,
	Conflict,
	Internal,
}

impl ErrorCode for Code {
	fn status(self) -> StatusCode {
		match self {
			Self::BadRequest => StatusCode::BAD_REQUEST,
			Self::NotFound => StatusCode::NOT_FOUND,
			Self::Conflict => StatusCode::CONFLICT,
			Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
		}
	}
}

/// What a domain crate refuses with: not the service's, so only `Refuses` maps it.
#[derive(Debug, thiserror::Error)]
enum Refused {
	#[error("the text is taken")]
	Taken,
	#[error("no such note")]
	Missing,
}

impl Refuses<Refused> for Code {
	fn refusal(e: Refused) -> Refusal<Self> {
		match e {
			Refused::Taken => Refusal::new(Self::Conflict, e.to_string()),
			Refused::Missing => Refusal::new(Self::NotFound, e.to_string()),
		}
	}
}

/// Stands for `eyre::Report`: `Display`, foreign, our own failure.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct Broke(String);

impl Refuses<Broke> for Code {
	fn refusal(_: Broke) -> Refusal<Self> {
		Refusal::new(Self::Internal, "internal error")
	}
}

#[derive(Clone)]
struct Open;

impl Guard<()> for Open {
	type Refusal = Code;

	fn permission(&self) -> Option<&'static str> {
		None
	}

	fn refusals(&self) -> Vec<Code> {
		Vec::new()
	}

	async fn admit(&self, _: &mut Parts, _: &()) -> Result<(), Refusal<Code>> {
		Ok(())
	}
}

#[derive(Deserialize, JsonSchema)]
struct NoteId {
	id: i64,
}

#[derive(Deserialize, JsonSchema, Serialize)]
struct Note {
	text: String,
}

#[derive(Deserialize, JsonSchema)]
struct Since {
	since: Option<String>,
}

fn found(id: i64) -> Result<Note, Refused> {
	match id {
		1 => Ok(Note { text: "one".into() }),
		_ => Err(Refused::Missing),
	}
}

fn store(text: &str) -> Result<(), Broke> {
	match text {
		"breaks" => Err(Broke("disk full".into())),
		_ => Ok(()),
	}
}

async fn get_note(Ids(NoteId { id }): Ids<NoteId>) -> Result<Json<Note>, Refusal<Code>> {
	Ok(Json(found(id)?))
}

async fn put_note(Ids(NoteId { id }): Ids<NoteId>, Body(note): Body<Note>) -> Result<Json<Note>, Refusal<Code>> {
	found(id)?;
	if note.text == "taken" {
		Err(Refused::Taken)?;
	}
	store(&note.text)?;
	Ok(Json(note))
}

async fn list_notes(Params(Since { since }): Params<Since>) -> Json<Vec<Note>> {
	Json(since.into_iter().map(|text| Note { text }).collect())
}

async fn live(ws: WebSocketUpgrade) -> Response {
	ws.on_upgrade(|_| async {})
}

const DOCS: ev_lib::api::Docs = &[
	("api::get_note", "A note."),
	("api::put_note", "Writes a note."),
	("api::list_notes", "Every note."),
	("api::live", "What changed."),
];

fn routes() -> Vec<Route<(), Open>> {
	vec![
		Route::new(Method::GET, "/notes", Open, list_notes),
		Route::new(Method::GET, "/notes/{id}", Open, get_note),
		Route::new(Method::PUT, "/notes/{id}", Open, put_note),
		Route::new(Method::GET, "/live", Open, live),
	]
}

fn doc() -> Value {
	serde_json::to_value(document("notes", "1", "/", &routes(), DOCS, None)).unwrap()
}

fn router() -> Router {
	routes().iter().fold(Router::new(), |r, route| r.merge(Router::new().route(route.path, route.handler())))
}

async fn call(app: &Router, method: Method, path: &str, body: &str) -> (StatusCode, Value) {
	let req = Request::builder()
		.method(method)
		.uri(path)
		.header(header::CONTENT_TYPE, "application/json")
		.body(Payload::from(body.to_owned()))
		.unwrap();
	let res = app.clone().oneshot(req).await.unwrap();
	let status = res.status();
	let body = to_bytes(res.into_body(), 1 << 20).await.unwrap();
	(status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// Exactly the extractors' codes, the guard's, and every one of the handler's `C`.
#[test]
fn an_operation_lists_what_it_refuses_with() {
	let doc = doc();
	let errors = |path: &str, method: &str| doc["paths"][path][method]["x-errors"].clone();
	let service = json!({ "bad_request": 400, "not_found": 404, "conflict": 409, "internal": 500 });
	assert_eq!(errors("/notes/{id}", "get"), service);
	assert_eq!(
		errors("/notes/{id}", "put"),
		json!({ "bad_request": 400, "not_found": 404, "conflict": 409, "internal": 500, "too_large": 413 })
	);
	assert_eq!(errors("/notes", "get"), json!({ "bad_request": 400 }));
	assert_eq!(errors("/live", "get"), json!({}));
	assert_eq!(doc["paths"]["/live"]["get"]["x-socket"], json!(true));
	assert_eq!(doc["paths"]["/notes"]["get"]["x-socket"], Value::Null);
	assert_eq!(
		doc["components"]["schemas"]["ErrorCode"]["enum"],
		json!(["bad_request", "conflict", "internal", "not_found", "too_large"])
	);
	assert_eq!(doc["components"]["schemas"]["Error"]["properties"]["code"]["$ref"], "#/components/schemas/ErrorCode");
	for status in ["400", "404", "409", "413", "500"] {
		assert_eq!(
			doc["paths"]["/notes/{id}"]["put"]["responses"][status]["content"]["application/json"]["schema"]["$ref"], "#/components/schemas/Error",
			"{status}"
		);
	}
	assert_eq!(op_id(put_note), "put_note");
	assert_eq!(routes()[2].id(), op_id(put_note));
}

#[derive(Clone, Copy, Serialize, strum::VariantArray)]
#[serde(rename_all = "snake_case")]
enum Gone {
	NotFound,
}

impl ErrorCode for Gone {
	fn status(self) -> StatusCode {
		StatusCode::GONE
	}
}

/// A ticket.
async fn ticket(Ids(NoteId { id }): Ids<NoteId>) -> Result<Json<i64>, Refusal<Gone>> {
	Ok(Json(id))
}

#[test]
#[should_panic(expected = "not_found is answered with one status")]
fn a_word_is_one_status() {
	document(
		"tickets",
		"1",
		"/",
		&[Route::new(Method::GET, "/tickets/{id}", Open, ticket)],
		&[("api::ticket", "A ticket.")],
		None,
	);
}

#[tokio::test]
async fn refusals_are_answered_as_documented() {
	let app = router();
	let refused = |code: &str, error: &str| json!({ "code": code, "error": error });
	assert_eq!(call(&app, Method::GET, "/notes/1", "").await, (StatusCode::OK, json!({ "text": "one" })));
	assert_eq!(call(&app, Method::GET, "/notes/x", "").await, (StatusCode::NOT_FOUND, refused("not_found", "not found")));
	assert_eq!(call(&app, Method::GET, "/notes/2", "").await, (StatusCode::NOT_FOUND, refused("not_found", "no such note")));
	assert_eq!(
		call(&app, Method::PUT, "/notes/1", r#"{"text":"taken"}"#).await,
		(StatusCode::CONFLICT, refused("conflict", "the text is taken"))
	);
	assert_eq!(
		call(&app, Method::PUT, "/notes/1", r#"{"text":"breaks"}"#).await,
		(StatusCode::INTERNAL_SERVER_ERROR, refused("internal", "internal error"))
	);
	let (status, body) = call(&app, Method::PUT, "/notes/1", "{").await;
	assert_eq!((status, &body["code"]), (StatusCode::BAD_REQUEST, &json!("bad_request")));
	let (status, body) = call(&app, Method::PUT, "/notes/1", &format!(r#"{{"text":"{}"}}"#, "a".repeat(3 << 20))).await;
	assert_eq!((status, &body["code"]), (StatusCode::PAYLOAD_TOO_LARGE, &json!("too_large")));
}

#[tokio::test]
async fn the_document_is_revalidated_by_its_etag() {
	let app: Router = Router::new().route("/openapi.json", serve(&doc(), Open));
	let get = |tag: Option<&str>| {
		let mut req = Request::builder().uri("/openapi.json");
		if let Some(tag) = tag {
			req = req.header(header::IF_NONE_MATCH, tag);
		}
		app.clone().oneshot(req.body(Payload::empty()).unwrap())
	};
	let first = get(None).await.unwrap();
	assert_eq!(first.status(), StatusCode::OK);
	let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
	assert_eq!(serde_json::from_slice::<Value>(&to_bytes(first.into_body(), 1 << 20).await.unwrap()).unwrap(), doc());
	for named in [etag.clone(), format!("W/{etag}"), format!("\"old\", {etag}"), "*".into()] {
		let res = get(Some(&named)).await.unwrap();
		assert_eq!(res.status(), StatusCode::NOT_MODIFIED, "{named}");
		assert_eq!(res.headers()[header::ETAG], etag);
	}
	assert_eq!(get(Some("\"old\"")).await.unwrap().status(), StatusCode::OK);
}

#[test]
fn a_rust_client_of_the_document() {
	insta::assert_snapshot!(rust_client(&doc(), "crate::dto"));
}
