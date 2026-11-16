# `ev_lib::views`

A service's views (where a person can be on its pages) as one enum, a variant per view. Each
view's href and its parse come from it, as does the table (`x-views`) that the service's OpenAPI
document carries (`api::document(…, Some(View::table()))`) and `@evinvest/views` reads.

```rust,ignore
#[derive(Views)]
#[views(carried = Outline)] // query keys beside every view: the page keeps them across its moves
enum View {
    /// The map of the caller's GMBs.
    #[view("/", key = 'h')]
    Home { gmb: Option<i64>, tab: Option<Tab>, trash: bool },
    /// A GMB's board.
    #[view("/gmbs/{gmb}", needs = Archive::Read)]
    Gmb { gmb: i64 },
    #[view("/members/{member}", nest)] // `Board`'s views under it: `theirs.<board's>`
    Theirs { member: i64, view: Board },
    /// sites' pages, its element's to route.
    #[view("/sites", nest = "sites", key = 's', scope = 'v')] // filled by `Table::nest("sites", …)`
    Sites { below: String },
}
```

- **A field named in the path is a path param; every other field is a query key**, or, marked
  `#[view(flatten)]`, a struct whose fields are (an operation's query type: the keys have one source). The view's name
  is its variant's, snake_case; its `///` is its description, which an agent picks it by.
- `needs` names the permission that opens it (anything with an `.as_str()`, as concierge_iam's
  permissions are); `key` is its letter in the page's nav, on a view with nothing to fill.
- **One codec**, read off the table's schemas, here and in `@evinvest/views`
  (`tests/fixtures/views/` holds both to it):

  | the field's schema            | in the URL                                | absent      |
  | ----------------------------- | ----------------------------------------- | ----------- |
  | string, enum, integer, number | its text                                  | refused     |
  | `bool` (query only)           | `key=`                                    | `false`     |
  | a list of those               | comma-joined, an item with no comma       | `[]`        |
  | a tuple of those              | comma-joined                              | refused     |
  | an object                     | its JSON                                  | refused     |
  | `Option` of any but `bool`    | as its inner; `Some([])` is `key=`        | `None`      |

  A query is `application/x-www-form-urlencoded`, sorted by key; a key no view or carried state has
  is refused. Paths match by specificity, position by position (a static segment beats a param, a
  param a nest's rest), not by order.
- **A table is checked when first built**: two views of one path, a name both a param and a query
  key, a type with no URL form, and every view hrefs a sampled value and parses back to it. What
  one enum shows is a compile error instead.
- A typed nest takes another enum's views under its path (their keys kept where nothing must be
  filled, its `needs` theirs, refused where one of them names its own: a view opens on one
  permission); a foreign one (`nest = "<service>"`) is a mark the host fills with that service's table
  (`Table::nest`), everything under it the nested views' or `below`'s.
- With `views_dioxus`, a `Routable` routes through `#[route("/:..at")] At { at: Routed<View> }`:
  its paths are the views'.
