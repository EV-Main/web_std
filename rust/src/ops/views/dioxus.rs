//! A Dioxus `Routable`'s catch-all over a views enum, so its paths are written once, on the views.

use std::fmt;

use dioxus::router::{FromRouteSegments, ToRouteSegments};
use percent_encoding::utf8_percent_encode;

use super::{Error, Views, table::SEGMENT};

/// `#[route("/:..at")] At { at: Routed<View> }`: the route is the view's href.
#[derive(Clone, Debug, PartialEq)]
pub struct Routed<V>(pub V);

impl<V: Views> ToRouteSegments for Routed<V> {
	fn display_route_segments(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		assert!(
			V::table().has_no_query(),
			"shortcut: Dioxus splits the query off before a catch-all sees it, so a Routed table takes none; add a `?:..q` twin when one does"
		);
		f.write_str(&self.0.href())
	}
}

impl<V: Views> FromRouteSegments for Routed<V> {
	type Err = Error;

	fn from_route_segments(segments: &[&str]) -> Result<Self, Error> {
		assert!(
			V::table().has_no_query(),
			"shortcut: Dioxus splits the query off before a catch-all sees it, so a Routed table takes none; add a `?:..q` twin when one does"
		);
		// Dioxus hands the segments decoded.
		let path: String = segments.iter().map(|s| format!("/{}", utf8_percent_encode(s, SEGMENT))).collect();
		V::parse(if path.is_empty() { "/" } else { &path }).map(Self)
	}
}
