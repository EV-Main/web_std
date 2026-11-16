//! What `ev_lib::sqlite` tells and stamps, through `ev_lib::api` routes over one pool.

use std::{collections::BTreeSet, sync::Arc, time::Duration};

use axum::{
	Json, Router,
	body::Body,
	extract::State,
	http::{Method, Request, request::Parts},
	response::Response,
};
use ev_lib::api::{Guard, Malformed, Refusal, Route};
use serde_json::Value;
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use tokio::sync::{Barrier, mpsc};
use tower::ServiceExt;

#[derive(Clone)]
struct App {
	pool: SqlitePool,
	met: Arc<Barrier>,
}

/// Reads `sessions` before every handler, as a service's session check does.
#[derive(Clone)]
struct Session;

impl Guard<App> for Session {
	type Refusal = Malformed;

	fn permission(&self) -> Option<&'static str> {
		None
	}

	fn refusals(&self) -> Vec<Malformed> {
		Vec::new()
	}

	async fn admit(&self, _: &mut Parts, app: &App) -> Result<(), Refusal<Malformed>> {
		sqlx::query("SELECT count(*) FROM sessions").fetch_one(&app.pool).await.expect("sessions is there");
		Ok(())
	}
}

/// Adds a parent (its trigger logs it) and deletes the first, whose child cascades.
async fn write(State(app): State<App>) -> Json<Value> {
	let mut tx = app.pool.begin().await.unwrap();
	sqlx::query("INSERT INTO p(a) VALUES (2)").execute(&mut *tx).await.unwrap();
	sqlx::query("DELETE FROM p WHERE id = 1").execute(&mut *tx).await.unwrap();
	tx.commit().await.unwrap();
	Json(Value::Null)
}

/// Reads through the view, a table-valued function and a bare count.
async fn read(State(app): State<App>) -> Json<Value> {
	sqlx::query("SELECT * FROM v").fetch_all(&app.pool).await.unwrap();
	sqlx::query("SELECT value FROM json_each('[1]')").fetch_all(&app.pool).await.unwrap();
	sqlx::query("SELECT count(*) FROM log").fetch_one(&app.pool).await.unwrap();
	Json(Value::Null)
}

/// Reads no table.
async fn nothing() -> Json<Value> {
	Json(Value::Null)
}

/// Writes twice, keeping neither: one transaction dropped, one rolled back.
async fn undone(State(app): State<App>) -> Json<Value> {
	let mut dropped = app.pool.begin().await.unwrap();
	sqlx::query("INSERT INTO log VALUES (7)").execute(&mut *dropped).await.unwrap();
	drop(dropped);
	let mut rolled = app.pool.begin().await.unwrap();
	sqlx::query("INSERT INTO p(a) VALUES (7)").execute(&mut *rolled).await.unwrap();
	rolled.rollback().await.unwrap();
	Json(Value::Null)
}

async fn read_held(app: &App, table: &str) {
	let mut conn = app.pool.acquire().await.unwrap();
	let count = format!("SELECT count(*) FROM {table}");
	sqlx::query(sqlx::AssertSqlSafe(count.clone())).fetch_one(&mut *conn).await.unwrap();
	app.met.wait().await;
	sqlx::query(sqlx::AssertSqlSafe(count)).fetch_one(&mut *conn).await.unwrap();
}

/// Reads `p` while `read_log` holds its own connection.
async fn read_p(State(app): State<App>) -> Json<Value> {
	read_held(&app, "p").await;
	Json(Value::Null)
}

/// Reads `log` while `read_p` holds its own connection.
async fn read_log(State(app): State<App>) -> Json<Value> {
	read_held(&app, "log").await;
	Json(Value::Null)
}

const SCHEMA: &str = "
	CREATE TABLE sessions(id INTEGER PRIMARY KEY);
	CREATE TABLE p(id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER);
	CREATE TABLE ch(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ON DELETE CASCADE);
	CREATE TABLE log(a INTEGER);
	CREATE TABLE marker(id INTEGER PRIMARY KEY);
	CREATE TRIGGER logged AFTER INSERT ON p BEGIN INSERT INTO log VALUES (new.a); END;
	CREATE VIEW v AS SELECT p.a, ch.id AS child FROM p JOIN ch ON ch.p = p.id;
	INSERT INTO p(a) VALUES (1);
	INSERT INTO ch(p) VALUES (1);
";

struct Db {
	app: App,
	router: Router,
	told: mpsc::UnboundedReceiver<String>,
}

impl Db {
	async fn new(max_connections: u32) -> Self {
		let (tx, told) = mpsc::unbounded_channel();
		let options: SqliteConnectOptions = "sqlite::memory:".parse().unwrap();
		let pool = ev_lib::sqlite::pool("svc", options, max_connections, Duration::from_secs(5), move |topic| {
			tx.send(topic.to_owned()).expect("the test listens")
		});
		sqlx::raw_sql(SCHEMA).execute(&pool).await.unwrap();
		let app = App {
			pool,
			met: Arc::new(Barrier::new(2)),
		};
		let routes = [
			Route::new(Method::POST, "/write", Session, write),
			Route::new(Method::GET, "/read", Session, read),
			Route::new(Method::GET, "/nothing", Session, nothing),
			Route::new(Method::POST, "/undone", Session, undone),
			Route::new(Method::GET, "/read_p", Session, read_p),
			Route::new(Method::GET, "/read_log", Session, read_log),
		];
		let router = routes.iter().fold(Router::new(), |r, route| r.route(route.path, route.handler())).with_state(app.clone());
		let mut db = Self { app, router, told };
		db.written().await;
		db
	}

	async fn call(&self, method: Method, path: &str) -> Response {
		let res = self
			.router
			.clone()
			.oneshot(Request::builder().method(method).uri(path).body(Body::empty()).unwrap())
			.await
			.unwrap();
		assert!(res.status().is_success(), "{path}: {}", res.status());
		res
	}

	/// Every topic told since the last call. With one connection, the marker's write waits for
	/// whatever held it to be released, so it is told last.
	async fn written(&mut self) -> BTreeSet<String> {
		sqlx::query("INSERT INTO marker DEFAULT VALUES").execute(&self.app.pool).await.unwrap();
		let mut told = BTreeSet::new();
		loop {
			let topic = tokio::time::timeout(Duration::from_secs(5), self.told.recv())
				.await
				.expect("the marker is told")
				.expect("the sink lives");
			if topic == "svc.marker" {
				return told;
			}
			told.insert(topic);
		}
	}
}

fn reads(res: &Response) -> &str {
	res.headers().get("x-sa-reads").expect("a GET answer is stamped").to_str().unwrap()
}

fn topics(names: &[&str]) -> BTreeSet<String> {
	names.iter().map(|n| format!("svc.{n}")).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_committed_write_is_told_with_exactly_the_tables_it_changed() {
	let mut db = Db::new(1).await;
	let res = db.call(Method::POST, "/write").await;
	assert!(res.headers().get("x-sa-reads").is_none(), "only a GET is stamped");
	assert_eq!(
		db.written().await,
		topics(&["ch", "log", "p"]),
		"the trigger's and the cascade's tables too; sessions and the FK's reads are no write"
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_get_is_stamped_with_the_tables_it_read_and_nothing_else() {
	let db = Db::new(1).await;
	assert_eq!(
		reads(&db.call(Method::GET, "/read").await),
		"svc.ch, svc.log, svc.p",
		"a view by its tables, no json_each, not the gate's sessions"
	);
	assert_eq!(reads(&db.call(Method::GET, "/nothing").await), "");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rolled_back_write_tells_nothing() {
	let mut db = Db::new(1).await;
	db.call(Method::POST, "/undone").await;
	assert_eq!(db.written().await, BTreeSet::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_requests_are_stamped_with_their_own_reads() {
	let db = Db::new(2).await;
	for _ in 0..20 {
		let (p, log) = tokio::join!(db.call(Method::GET, "/read_p"), db.call(Method::GET, "/read_log"));
		assert_eq!((reads(&p), reads(&log)), ("svc.p", "svc.log"));
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_outside_any_request_is_told_and_no_connection_escapes_the_record() {
	let mut db = Db::new(1).await;
	sqlx::query("UPDATE log SET a = 3").execute(&db.app.pool).await.unwrap();
	assert_eq!(db.written().await, topics(&["log"]));
	// The marker's connection is told before it is idle again: its release ends after the sink.
	let mut unrecorded = loop {
		if let Some(conn) = db.app.pool.try_acquire() {
			break conn;
		}
		tokio::task::yield_now().await;
	};
	let refused = sqlx::query("SELECT * FROM p").fetch_all(&mut *unrecorded).await.unwrap_err();
	assert_eq!(refused.as_database_error().and_then(|e| e.code()).as_deref(), Some("23"), "SQLITE_AUTH: {refused}");
}
