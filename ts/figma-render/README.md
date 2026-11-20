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
one of its sections' `selector` is in the DOM. From them the crawl follows every same-origin `<a href>` on the
config's first project, skipping `exclude` and what is not `text/html`. A page is the URL without its `#`; pages
that differ only in their numbers (ids, coordinates, dates) are one frame (`shapeOf`). A state no link reaches needs
a section of its own. Each page is captured at the first project in the tab that crawled it, and loaded and captured
at every other project; at most 5 tabs are open at once, visits first (each is the same login, and a site may cap one
user's live sockets: site_conductor's 5). A capture only serializes: capture.js's submit
is answered in the tab, and its payload goes to the bin. A visit (goto, sections, settle) has 30 s, a capture as much;
a page past its budget, or answered with a 5xx, is one named failure and the run goes on. Each tab logs one line,
ending in what the bin did with the payload: `✓ desktop /usage 2.3s (load 2.1s) uploaded`, `… cached`,
`… ≡ /trash` (the same payload as that page's), `✘ mobile /x 30.0s: goto: past the 30s budget`.

`oneDocument` names pages that are one document: the first is loaded, the rest are reached in its tab by
`history.pushState` and a `popstate`, as a single-page app's links move, and each is captured at every project by
resizing the viewport. A document that buys something per load (a billed map) buys it once a run; its pages are visited
one after another, beside a pool one tab smaller. Its projects may differ only in `viewport`.

```sh
evinvest-figma-render -c tests/e2e --file <fileKey>          # stdout: the new page's link
evinvest-figma-render -c tests/e2e --folder <folder URL> --name <file name>   # the same, as all of that file
```

`--folder` (over `--file`) renders into the file named `--name` in that Figma folder, created there if missing, and
leaves it holding only the new page: CI points every repo at one folder (v_flakes `github.figma`). MCP cannot list a
folder, so this needs `FIGMA_TOKEN`, a personal access token with `folders:read`.

The bin is a client of Figma's MCP server and runs the whole render. The suite posts each payload to `FIGMA_ISSUER`, a
local endpoint. Figma frames about 0.5 uploads a second per file, however many are in flight, so the bin uploads only
what the file does not hold: a payload is keyed `<project> <sha256>`, and the file's page `figma-render cache` keeps one
frame per key. A key cached there, or already taken this run, costs nothing; a new one gets a capture id
(`generate_figma_design`) and is uploaded from Node, 4 at once, 180 s each, then polled for its frame. Then one
`use_figma` moves the new frames onto the cache page, removes the cache frames this run did not use, and clones every
frame onto a page named `<short sha> <YYYY-MM-DD>[ dirty]`, named `<project> <page>`: a group of columns per first path
segment, sorted, within it a column per project (in the config's order) and a row per page (sorted); a cache frame is
named and placed as its first clone.
A page named so whose `arrange` was another (its sha256, kept on the page) is removed. That `use_figma` is the run's only call Figma counts toward its rate
limit. The cache page's ids are kept in `$XDG_STATE_HOME/evinvest-figma-render/cache.json`; a cached frame gone from
Figma fails the run, naming it, and drops the file's entry, so the next run uploads everything again. A frame not
uploaded or still pending after the polls is a failed test: it is named, and the exit is 1.

The first run logs in to Figma in the browser (OAuth with PKCE, a callback on `127.0.0.1:47613`); the
client and its tokens are kept in `$XDG_STATE_HOME/evinvest-figma-render/oauth.json`; under `CI` there is no login,
so that file has to hold a usable token. `playwright` is taken
from `PATH`, so the caller's pinned runner and browsers render the frames. `settle(page, selector)` is
exported for screenshot suites that want the same notion of a finished page.
