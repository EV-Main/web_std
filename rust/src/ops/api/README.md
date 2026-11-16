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
- **The handler's name is the operation's id**, unique in the table; its module the tag. [`op_id`]
  gives it from the fn item, so a caller naming an operation (an alert's button) is compile-checked.
- **A refusal is `{code, error}`** ([`Refusal<C>`](Refusal)), `C` the service's closed
  [`ErrorCode`] enum: the word is its serde name, its status one `match`. Each operation's
  `x-errors` (`{word: status}`, `{}` when it refuses nothing) is what its signature can answer: the
  codes [`Body`], [`Params`] and [`Ids`] refuse with ([`Malformed`]), its guard's, and every code of
  the handler's `C`. A narrower `C` is a narrower list. The `Error` schema's `code` is `ErrorCode`,
  every word of the document, and a word is one status across it. A domain error becomes a refusal
  through `impl Refuses<TheError> for C`, so `?` works where the orphan rule forbids a `From`.
- **A socket is a route like any other** (feature `api_ws`): its handler takes `WebSocketUpgrade`,
  which answers 101, and its operation is marked `x-socket`. It is opened by a GET.
- **[`serve`]** answers a document (or any JSON fixed while the process lives) behind a guard, with
  an ETag, and `304` for an `If-None-Match` naming it. It is not an operation of the document.
- **[`rust_client`]** (feature `api_gen`, build-time) writes a client's methods from the document,
  its schemas bound by name to the service's own Rust types. The including module keeps how a
  request is sent.
- **What only the service knows** rides on the route: its gate (`G`, the permission it names
  becomes `x-permission`). Anything else an operation is (what it spends, say) is an extractor of
  the service's whose `OperationInput` writes its extension. Read-only, idempotent and destructive
  follow from the method and are not stored.
