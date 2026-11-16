use std::hash::{DefaultHasher, Hash, Hasher};

use axum::{
	body::Bytes,
	http::{HeaderMap, HeaderValue, StatusCode, header},
	response::IntoResponse,
	routing::{MethodRouter, get},
};
use serde::Serialize;

use super::route::{Gated, Guard};

/// `GET` of `json` (a service's document, say), fixed while the process lives, behind `guard`:
/// it carries an ETag, and an `If-None-Match` naming it is answered `304`.
pub fn serve<S: Clone + Send + Sync + 'static, G: Guard<S>>(json: &impl Serialize, guard: G) -> MethodRouter<S> {
	let body = Bytes::from(serde_json::to_vec(json).expect("what is served serializes"));
	let mut digest = DefaultHasher::new();
	body.hash(&mut digest);
	let etag = HeaderValue::try_from(format!("\"{:016x}\"", digest.finish())).expect("hex in quotes is a header value");
	let answer = move |headers: HeaderMap| async move {
		// an edge that compresses weakens the tag it passes on
		let named = headers
			.get_all(header::IF_NONE_MATCH)
			.iter()
			.filter_map(|v| v.to_str().ok()) // one that is not text names no tag of ours
			.flat_map(|v| v.split(','))
			.map(|t| t.trim())
			.any(|t| t == "*" || t.strip_prefix("W/").unwrap_or(t).as_bytes() == etag.as_bytes());
		match named {
			true => (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response(),
			false => (
				[
					(header::CONTENT_TYPE, HeaderValue::from_static("application/json")),
					(header::ETAG, etag),
					(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
				],
				body,
			)
				.into_response(),
		}
	};
	get(Gated { guard, handler: answer })
}
