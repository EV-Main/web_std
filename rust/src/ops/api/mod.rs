#![doc = include_str!("README.md")]

#[cfg(feature = "api_gen")]
mod client_gen;
#[cfg(feature = "api_docs")]
pub mod docs;
#[cfg(feature = "api")]
mod refusal;
#[cfg(feature = "api")]
mod route;
#[cfg(feature = "api")]
mod serve;
#[cfg(feature = "api_gen")]
pub use client_gen::rust_client;
#[cfg(feature = "api")]
pub use refusal::{Body, ErrorCode, Ids, Malformed, Params, Refusal, Refuses};
#[cfg(feature = "api")]
pub use route::*;
#[cfg(feature = "api")]
pub use serve::serve;
