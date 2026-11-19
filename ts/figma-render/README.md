# `@evinvest/figma-render`

A site's pages, as its own Playwright suite renders them, serialized into Figma frames through
`generate_figma_design`'s capture script. Figma is a debug artifact here: nothing is read back. No Rust
twin.

```ts
// tests/e2e/figma.spec.ts — the config's projects are the breakpoints
import { test } from "@playwright/test";
import { defineFigmaSuite } from "@evinvest/figma-render";

defineFigmaSuite({ test }, [
  { name: "home", url: "/", selector: "main" },
  { name: "assistant", url: "/?assistant=sidebar", selector: "[aria-label=Assistant]" },
], { hide: ["nextjs-portal"], exclude: [/^\/auth\//] });
```

The sections are where a crawl starts: a state worth seeing, reached by its own URL, its page captured once every
one of its sections' `selector` is in the DOM. From them the crawl follows every same-origin `<a href>`, breadth
first, on the config's first project, skipping `exclude` and what is not `text/html`. A page is the URL without
its `#`; pages that differ only in their numbers (ids, coordinates, dates) are one frame (`shapeOf`). A state no link
reaches needs a section of its own. Every page found is then captured at every project.

```sh
evinvest-figma-render -c tests/e2e --file <fileKey>          # stdout: the new page's link
evinvest-figma-render -c tests/e2e --folder <folder URL> --name <file name>   # the same, as all of that file
```

`--folder` (over `--file`) renders into the file named `--name` in that Figma folder, created there if missing, and
leaves it holding only the new page: CI points every repo at one folder (v_flakes `github.figma`). MCP cannot list a
folder, so this needs `FIGMA_TOKEN`, a personal access token with `folders:read`.

The bin is a client of Figma's MCP server and runs the whole render: the suite, given `FIGMA_ISSUER`, a local
endpoint that issues a capture id (`generate_figma_design`) for each frame the crawl asks one for; then a poll per id for its frame, then one `use_figma` that
puts the frames on a page named `<short sha> <YYYY-MM-DD>[ dirty]`, names each `<project> <page>` and lays
them out a row per page, a column per project. That `use_figma` is the run's only call Figma counts toward
its rate limit. A frame still pending after the polls is a failed test: it is named, and the exit is 1.

The first run logs in to Figma in the browser (OAuth with PKCE, a callback on `127.0.0.1:47613`); the
client and its tokens are kept in `$XDG_STATE_HOME/evinvest-figma-render/oauth.json`; under `CI` there is no login,
so that file has to hold a usable token. `playwright` is taken
from `PATH`, so the caller's pinned runner and browsers render the frames. `settle(page, selector)` is
exported for screenshot suites that want the same notion of a finished page.
