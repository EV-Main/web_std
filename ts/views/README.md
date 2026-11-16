# @evinvest/views

A service's views by its generated table: `href` and `parse` over `VIEWS`, which the service's
`nix run .#gen` writes from its Rust views enum (ev_lib's `views`; the same table is its document's
`x-views`). The views, their params and their query keys are typed from the table alone.

```ts
import { href, parse } from "@evinvest/views";
import { VIEWS } from "@/shared/generated/views"; // Ts::Value { name: "VIEWS", value: to_value(View::table()) }

href(VIEWS, { view: "gmb", params: { gmb: 5, tab: "kit" } }, carried); // "/gmbs/5?tab=kit"
const { at, carried } = parse(VIEWS, location.pathname + location.search); // throws ViewError
```

| Rust (`ev_lib::views`)        | TS                                         |
| ----------------------------- | ------------------------------------------ |
| `Table::href(&at, &carried)`  | `href(table, at, carried?)`                |
| `Table::parse(href)`          | `parse(table, href)` → `{ at, carried }`   |
| `At { view, params }`         | `At<typeof VIEWS>`, a union by `view`      |
| `Err(views::Error)`           | throws `ViewError`                         |
| a view's `needs`              | `mayOpen(table, view, permissions)`        |
| an absent `Option`/flag/list  | the key left out                           |
| `i64`/`u64` in a view         | `number`, a safe integer checked           |

The codec is the Rust's, rule for rule (`rust/src/ops/views/README.md`); `tests/fixtures/views/`
is what both suites answer alike. Links are carried-free: the page passes its carried state to
`href` to keep it.
