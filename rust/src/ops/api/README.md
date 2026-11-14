# `ev_lib::api`

A service's operations as one table of [`Route`]s: the router is built from it, and its OpenAPI
document is derived from it, so a path, a method or a type is written once. A UI, an agent's tools
and the generated TS client are all clients of that document.

- **The signature is the schema.** A route's request and answer are its handler's extractors and
  return type (`aide`'s `OperationInput` / `OperationOutput` over `schemars`' `JsonSchema`). An
  extractor of the service's own implements `OperationInput` (empty when it takes nothing from the
  request), a response of its own `OperationOutput`. [`Created`] is a `201`; `axum`'s `NoContent`
  a `204`.
- **The handler's `///` is the operation's description**, its first paragraph the summary. The
  service's `build.rs` calls `docs::write()` (feature `api_docs`), and [`document`] takes
  `api_docs!()`; a route whose handler has none, or is a closure, fails the document.
- **The handler's name is the operation's id**, unique in the table; its module the tag.
- **What only the service knows** rides on the route: its gate (`G`, the permission it names
  becomes `x-permission`) and whether it [`spends`](Route::spends) (`x-spends`). Read-only,
  idempotent and destructive follow from the method and are not stored.
