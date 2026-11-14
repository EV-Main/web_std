#![doc = include_str!("README.md")]

#[cfg(feature = "api_docs")]
pub mod docs;
#[cfg(feature = "api")]
mod route;
#[cfg(feature = "api")]
pub use route::*;
