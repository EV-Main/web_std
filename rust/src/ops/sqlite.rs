//! Which tables a service's statements read and write, as SQLite itself reports them: its
//! authorizer, set on every connection of the pool [`pool`] builds.
//!
//! - **Writes are told once committed**, as `<service>.<table>` topics to the service's sink, when
//!   the connection that made them goes back to the pool (or closes). A write rolled back tells
//!   nothing. Whether a request, a background task or a migration took the connection makes no
//!   difference.
//! - **Reads are stamped**: an `ev_lib::api` GET operation's answer carries `x-sa-reads`, the
//!   topics its handler read (empty when it read none). The gate runs before collection starts,
//!   so a session check is never among them.
//! - **A table a client can follow** is a `main` table of the schema, but SQLite's own
//!   (`sqlite_*`) and sqlx's `_sqlx_migrations`. A view is not one (its tables are), nor a temp
//!   table, nor a table-valued function (`json_each`, `pragma_*`).
//!
//! The statement cache is off, so every statement is prepared, and so authorized. A write is known
//! when its statement is prepared: an `UPDATE` that matches no row, or a savepoint rolled back
//! inside a transaction that commits, is still told.

use std::{
	collections::BTreeSet,
	ffi::{CStr, c_char, c_int, c_void},
	mem,
	panic::{AssertUnwindSafe, catch_unwind},
	ptr,
	sync::{
		Arc, Mutex, OnceLock, RwLock,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use libsqlite3_sys as ffi;
use sqlx::{
	SqliteConnection, SqlitePool,
	sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

tokio::task_local! {
	/// The reads of the GET operation whose handler is running on this task.
	static READS: Arc<Reads>;
}

/// The pool of `service`'s database at `options`: every committed write's topic is given to
/// `sink`, once per table and connection hold.
///
/// The pool connects lazily; it must be built inside a tokio runtime.
pub fn pool(service: &'static str, options: SqliteConnectOptions, max_connections: u32, acquire_timeout: Duration, sink: impl Fn(&str) + Send + Sync + 'static) -> SqlitePool {
	let shared = Arc::new(Shared {
		service,
		sink: Box::new(sink),
		tables: RwLock::default(),
		schema_moved: AtomicBool::new(false),
	});
	let (connected, acquired, released) = (shared.clone(), shared.clone(), shared);
	SqlitePoolOptions::new()
		.max_connections(max_connections)
		.acquire_timeout(acquire_timeout)
		.after_connect(move |conn, _| {
			let shared = connected.clone();
			Box::pin(async move {
				shared.load_tables(conn).await?;
				bind(conn, shared).await
			})
		})
		.before_acquire(move |conn, _| {
			let shared = acquired.clone();
			Box::pin(async move { bind(conn, shared).await.map(|()| true) })
		})
		.after_release(move |conn, _| {
			let shared = released.clone();
			Box::pin(async move { unbind(conn, &shared).await.map(|()| true) })
		})
		.connect_lazy_with(options.statement_cache_capacity(0))
}

/// Runs a GET operation's handler, its answer stamped with the topics the handler read.
#[cfg(feature = "api")]
pub(crate) async fn stamped(handler: impl Future<Output = axum::response::Response>) -> axum::response::Response {
	let reads = Arc::new(Reads::default());
	let mut answer = READS.scope(reads.clone(), handler).await;
	let topics = match reads.pool.get() {
		None => String::new(),
		Some(pool) => {
			let tables = pool.tables.read().expect("no writer of the tables panics");
			let read = reads.tables.lock().expect("the authorizer never panics holding it");
			read.iter().filter(|t| tables.contains(*t)).map(|t| pool.topic(t)).collect::<Vec<_>>().join(", ")
		}
	};
	answer
		.headers_mut()
		.insert("x-sa-reads", axum::http::HeaderValue::try_from(topics).expect("a schema's table names are visible ASCII"));
	answer
}

/// One pool's: what its connections report to.
struct Shared {
	service: &'static str,
	sink: Box<dyn Fn(&str) + Send + Sync>,
	/// The tables a client can follow, as the schema last stood.
	tables: RwLock<BTreeSet<String>>,
	/// A connection ran DDL since the tables were last read.
	schema_moved: AtomicBool,
}

impl Shared {
	async fn load_tables(&self, conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
		let names: Vec<String> = sqlx::query_scalar(r"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name <> '_sqlx_migrations'")
			.fetch_all(conn)
			.await?;
		*self.tables.write().expect("no writer of the tables panics") = names.into_iter().collect();
		Ok(())
	}

	fn topic(&self, table: &str) -> String {
		format!("{}.{table}", self.service)
	}
}

/// The tables a GET operation's handler read, on whichever connections it took.
#[derive(Default)]
struct Reads {
	tables: Mutex<BTreeSet<String>>,
	/// The pool the handler read from: its tables decide what is followable.
	pool: OnceLock<Arc<Shared>>,
}

/// A connection, from the moment it is taken from the pool until it goes back.
struct Bound {
	pool: Arc<Shared>,
	/// `None` outside a GET operation's handler: what is read there is no one's to stamp.
	reads: Option<Arc<Reads>>,
	/// Written by statements of the transaction open now.
	pending: Mutex<BTreeSet<String>>,
	/// Written by transactions that committed.
	written: Mutex<BTreeSet<String>>,
}

impl Drop for Bound {
	fn drop(&mut self) {
		let written = mem::take(self.written.get_mut().expect("the commit hook never panics holding it"));
		let tables = self.pool.tables.read().expect("no writer of the tables panics");
		for table in written.iter().filter(|t| tables.contains(*t)) {
			(self.pool.sink)(&self.pool.topic(table));
		}
	}
}

/// Ties the connection to the task taking it. Under the handle lock: whatever was queued on it
/// before has run.
async fn bind(conn: &mut SqliteConnection, pool: Arc<Shared>) -> Result<(), sqlx::Error> {
	// Absent on any task but a GET operation's handler's: its writes are told all the same.
	let reads = READS.try_with(Arc::clone).ok();
	if let Some(reads) = &reads {
		assert!(Arc::ptr_eq(reads.pool.get_or_init(|| pool.clone()), &pool), "an operation reads from one touched pool");
	}
	let bound = Arc::new(Bound {
		pool,
		reads,
		pending: Mutex::default(),
		written: Mutex::default(),
	});
	let mut handle = conn.lock_handle().await?;
	// The hooks set below own `bound`, and are dropped only after the authorizer stops pointing at it.
	let set = unsafe { ffi::sqlite3_set_authorizer(handle.as_raw_handle().as_ptr(), Some(authorize), Arc::as_ptr(&bound).cast_mut().cast()) };
	assert_eq!(set, ffi::SQLITE_OK, "setting an authorizer cannot fail on an open connection");
	let committing = bound.clone();
	handle.set_commit_hook(move || {
		let pending = mem::take(&mut *committing.pending.lock().expect("the authorizer never panics holding it"));
		committing.written.lock().expect("nothing panics holding it").extend(pending);
		true
	});
	handle.set_rollback_hook(move || bound.pending.lock().expect("the authorizer never panics holding it").clear());
	Ok(())
}

/// Lets the connection go: once its queue has run, what it committed is told.
async fn unbind(conn: &mut SqliteConnection, pool: &Shared) -> Result<(), sqlx::Error> {
	if pool.schema_moved.swap(false, Ordering::Relaxed) {
		pool.load_tables(conn).await?;
	}
	let mut handle = conn.lock_handle().await?;
	let db = handle.as_raw_handle().as_ptr();
	assert_ne!(unsafe { ffi::sqlite3_get_autocommit(db) }, 0, "a connection goes back to the pool outside any transaction");
	let set = unsafe { ffi::sqlite3_set_authorizer(db, Some(authorize), ptr::null_mut()) };
	assert_eq!(set, ffi::SQLITE_OK, "setting an authorizer cannot fail on an open connection");
	handle.remove_commit_hook();
	handle.remove_rollback_hook();
	Ok(())
}

/// SQLite's authorizer: `bound` is null between holds, when no statement may touch a table.
unsafe extern "C" fn authorize(bound: *mut c_void, action: c_int, a: *const c_char, _: *const c_char, db: *const c_char, _: *const c_char) -> c_int {
	// A panic must not cross into SQLite: the statement is refused instead.
	catch_unwind(AssertUnwindSafe(|| unsafe { authorized(bound.cast_const().cast::<Bound>().as_ref(), action, a, db) })).unwrap_or(ffi::SQLITE_DENY)
}

unsafe fn authorized(bound: Option<&Bound>, action: c_int, table: *const c_char, db: *const c_char) -> c_int {
	match action {
		ffi::SQLITE_READ | ffi::SQLITE_INSERT | ffi::SQLITE_UPDATE | ffi::SQLITE_DELETE => {}
		ffi::SQLITE_CREATE_TABLE | ffi::SQLITE_DROP_TABLE | ffi::SQLITE_ALTER_TABLE => {
			if let Some(bound) = bound {
				bound.pool.schema_moved.store(true, Ordering::Relaxed);
			}
			return ffi::SQLITE_OK;
		}
		_ => return ffi::SQLITE_OK,
	}
	// A read of no column (`count(*)`) names no database: it is `main`'s.
	if !db.is_null() && unsafe { CStr::from_ptr(db) } != c"main" {
		return ffi::SQLITE_OK;
	}
	let Ok(table) = unsafe { CStr::from_ptr(table) }.to_str() else { return ffi::SQLITE_DENY };
	if table.starts_with("sqlite_") {
		return ffi::SQLITE_OK;
	}
	let Some(bound) = bound else { return ffi::SQLITE_DENY };
	let into = match (action, &bound.reads) {
		(ffi::SQLITE_READ, Some(reads)) => &reads.tables,
		(ffi::SQLITE_READ, None) => return ffi::SQLITE_OK,
		_ => &bound.pending,
	};
	let mut tables = into.lock().expect("nothing panics holding it");
	if !tables.contains(table) {
		tables.insert(table.to_owned());
	}
	ffi::SQLITE_OK
}
