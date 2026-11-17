#![doc = include_str!("README.md")]

#[doc(hidden)]
pub mod __private;
#[cfg(feature = "views_dioxus")]
mod dioxus;
mod table;

use std::fmt;

#[cfg(feature = "views_dioxus")]
pub use dioxus::Routed;
pub use ev_lib_macros::Views;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
pub use table::Table;

/// A service's views: an enum, a variant per view (`#[derive(Views)]`, see the module).
pub trait Views: Sized {
	/// The views' table, the document's `x-views`: built and checked once.
	fn table() -> &'static Table;

	fn at(&self) -> At;

	/// Strict: a param the view has not, or one it needs and lacks, is refused.
	fn from_at(at: At) -> Result<Self, Error>;

	fn href(&self) -> String {
		Self::table().href(&self.at(), &Map::new()).expect("a view's own values fit its table")
	}

	/// The carried keys are checked and dropped: they are the page's, not the view's.
	fn parse(href: &str) -> Result<Self, Error> {
		Self::from_at(Self::table().parse(href)?.0)
	}
}

/// A view by name and its params (path and query alike), as an agent's `open` names one.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct At {
	pub view: String,
	pub params: Map<String, Value>,
}

/// An href that is no view, a view's params that do not fit it, or two tables that do not nest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Error(String);

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.0)
	}
}

impl std::error::Error for Error {}
