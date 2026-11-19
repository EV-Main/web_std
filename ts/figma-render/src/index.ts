import type { Browser, BrowserContextOptions, Page, TestType } from "@playwright/test";

/**
 * `@evinvest/figma-render` — a site's pages, as its own Playwright suite reaches them, serialized into Figma
 * frames through `generate_figma_design`'s capture script. Types only from `@playwright/test`: the caller passes
 * its own `test`, so this module loads nothing at run time and cannot end up with a second copy of the runner
 * (Playwright refuses to run with two).
 */

/** The describe the suite sits in; the bin greps by it. */
export const FIGMA_SUITE = "@figma";

const SETTLE: readonly (readonly [string, (page: Page, selector: string) => Promise<unknown>])[] = [
  ["fonts", page => page.evaluate(() => document.fonts.ready)],
  [
    "images",
    (page, selector) =>
      page.locator(selector).evaluate(root =>
        Promise.all(
          Array.from(root.querySelectorAll("img"), img => {
            img.loading = "eager";
            if (img.complete) return null;
            return new Promise(done => {
              img.addEventListener("load", done, { once: true });
              img.addEventListener("error", done, { once: true });
            });
          }),
        ),
      ),
  ],
  ["network idle", page => page.waitForLoadState("networkidle")],
  [
    "animations",
    page =>
      page.waitForFunction(
        () =>
          document
            .getAnimations()
            .filter(a => (a.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
            .every(a => a.playState === "finished" || a.playState === "idle"),
        undefined,
        { timeout: 10_000 },
      ),
  ],
];

/**
 * Waits until a selector's subtree is what a visitor sees: web fonts applied,
 * every image in it loaded (lazy ones forced), the network idle, and every
 * finite animation finished — `animations: "disabled"` freezes CSS animations,
 * not ones driven through the Web Animations API.
 */
export async function settle(page: Page, selector: string): Promise<void> {
  for (const [, step] of SETTLE) await step(page, selector);
}

/** What `generate_figma_design` hands out per frame, verbatim. */
export interface Capture {
  captureId: string;
  endpoint: string;
}

const CAPTURE_JS = "https://mcp.figma.com/mcp/html-to-design/capture.js";

/** A state of the site worth seeing, reached by its own URL. */
export interface Section {
  name: string;
  /** Relative to the config's `baseURL`, or absolute for another host. */
  url: string;
  /** What is there once the state is: its frame is captured only after every one of its sections' is. */
  selector: string;
}

export interface FigmaSuiteOptions {
  /** Selectors `display: none`d before the capture: dev overlays, QA menus. */
  hide?: readonly string[];
  /** Pages never visited, matched against `<path>?<query>`: links that act (sign-out), or lead to another app. */
  exclude?: readonly RegExp[];
}

const LIMIT = 300; // pages a crawl may find before the run fails, naming them: a shape `shapeOf` does not fold
const TABS = 16; // contexts open at once, visits and captures together
const LOAD = 30_000; // a visit: goto, its sections attached, settled; a ceiling against hangs, not a speed target
const CAPTURE = 240_000; // capture.js, the id, and the upload: Figma answers it only once processed, minutes into a busy run

/** A step racer against one end time `ms` from now: a step's failure or the end is `<label>: <why>`. */
function deadline(ms: number): <T>(label: string, step: Promise<T>) => Promise<T> {
  const end = Date.now() + ms;
  return async (label, step) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(`past the ${ms / 1000}s budget`)), end - Date.now())));
    try {
      return await Promise.race([step, late]);
    } catch (e) {
      throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** At most `n` tasks at once; a freed slot goes to a waiting visit before a waiting capture (visits discover work). */
function slots(n: number): <T>(kind: "visit" | "capture", task: () => Promise<T>) => Promise<T> {
  let free = n;
  const waiting = { visit: [] as (() => void)[], capture: [] as (() => void)[] };
  return async (kind, task) => {
    if (free > 0) free--;
    else await new Promise<void>(go => waiting[kind].push(go));
    try {
      return await task();
    } finally {
      const next = waiting.visit.shift() ?? waiting.capture.shift();
      if (next === undefined) free++;
      else next();
    }
  };
}

/** A page: the URL without its `#` (with its origin when it names another host). */
export function pageOf(url: string, base: string): string {
  const u = new URL(url, base);
  return (u.origin === new URL(base).origin ? "" : u.origin) + u.pathname + u.search;
}

/** One frame per shape: pages that differ only in their numbers (ids, coordinates, dates) are one. */
export function shapeOf(page: string): string {
  const u = new URL(page, "relative:/");
  const number = /-?\d+(\.\d+)?/g;
  const query = [...u.searchParams].map(([k, v]) => `${k}=${v.replace(number, "#")}`).sort();
  return (u.protocol === "relative:" ? "" : u.origin) + u.pathname.replace(number, "#") + (query.length > 0 ? `?${query.join("&")}` : "");
}

/** The keys of a project's `use` that are a browser context's. */
const CONTEXT_KEYS = ["baseURL", "viewport", "deviceScaleFactor", "isMobile", "hasTouch", "userAgent", "storageState", "locale", "timezoneId", "colorScheme", "extraHTTPHeaders", "httpCredentials", "ignoreHTTPSErrors"] as const;

/** Where the bin issues capture ids: `FIGMA_ISSUER`, a POST of `{ project, col, page }` answered with a `Capture`; `col` is the project's index in the config. */
async function issue(issuer: string, project: string, col: number, page: string): Promise<Capture> {
  const res = await fetch(issuer, { method: "POST", body: JSON.stringify({ project, col, page }) });
  if (!res.ok) throw new Error(`${issuer}: ${res.status} ${await res.text()}`);
  return (await res.json()) as Capture;
}

interface Info {
  project: { name: string };
  config: { projects: { name: string; use: Record<string, unknown> }[] };
  setTimeout(ms: number): void;
}

/**
 * One `@figma` test, run on the config's first project: the sections' pages and every same-origin page linked from
 * them, one per shape (`shapeOf`), crawled on that project in `TABS` tabs and captured there in the tab that crawled
 * them, then loaded and captured at every other project. Without `FIGMA_ISSUER` (the bin's) it is skipped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runner's fixture types are the caller's; only `browser` is read
export function defineFigmaSuite({ test }: { test: TestType<any, any> }, sections: readonly Section[], { hide = [], exclude = [] }: FigmaSuiteOptions = {}): void {
  test.describe(FIGMA_SUITE, () => {
    test("crawl", async ({ browser }: { browser: Browser }, info: Info) => {
      const issuer = process.env["FIGMA_ISSUER"];
      if (issuer === undefined) return test.skip(true, "run by evinvest-figma-render");
      const [first] = info.config.projects;
      if (first === undefined || info.project.name !== first.name) return test.skip(true, "the crawl runs once, on the first project");
      info.setTimeout(0); // every visit and capture is bounded, and LIMIT bounds their count

      // a context per visit: a page is what its URL alone shows, never what the one before it left in storage
      const projects = info.config.projects.map((p, col) => ({
        name: p.name,
        col,
        options: {
          ...(Object.fromEntries(CONTEXT_KEYS.filter(k => k in p.use).map(k => [k, p.use[k]])) as BrowserContextOptions),
          bypassCSP: true, // capture.js and its POST to Figma
          reducedMotion: "reduce",
        } satisfies BrowserContextOptions,
      }));
      type Project = (typeof projects)[number];
      const base = first.use["baseURL"];
      if (typeof base !== "string") throw new Error(`project ${first.name}: no baseURL to crawl from`);
      const origin = new URL(base).origin;

      const selectors = new Map<string, string[]>();
      for (const s of sections) {
        const page = pageOf(s.url, base);
        selectors.set(page, [...(selectors.get(page) ?? []), s.selector]);
      }

      /** The page in `tab`, its sections attached and settled: how long that took, or null when it is not HTML (a link to a file or an API). */
      const load = async (tab: Page, page: string): Promise<string | null> => {
        const started = Date.now();
        const within = deadline(LOAD);
        const res = await within("goto", tab.goto(page));
        if (res === null) throw new Error("goto: no response");
        if (res.status() >= 500) throw new Error(`goto: ${res.status()}`); // the server's answer; waiting on selectors would only burn the budget
        if (!(res.headers()["content-type"] ?? "").startsWith("text/html")) return null;
        for (const selector of selectors.get(page) ?? []) await within(`selector ${selector} attached`, tab.locator(selector).waitFor({ state: "attached" })); // attached: a section the breakpoint hides is still the page's
        for (const [label, step] of SETTLE) await within(label, step(tab, "body"));
        return `load ${((Date.now() - started) / 1000).toFixed(1)}s`;
      };

      const capture = async (tab: Page, project: Project, page: string): Promise<void> => {
        const within = deadline(CAPTURE);
        if (hide.length > 0) await within("hide", tab.addStyleTag({ content: `${hide.join(", ")} { display: none !important; }` }));
        await within("capture.js", tab.addScriptTag({ url: CAPTURE_JS }));
        const c = await within("issue", issue(issuer, project.name, project.col, page));
        const [response] = await Promise.all([
          within("upload", tab.waitForResponse(r => r.url() === c.endpoint && r.request().method() === "POST", { timeout: 0 })),
          // Its promise never settles; the submit's response is the end.
          within(
            "submit",
            tab.evaluate(c => {
              void (window as unknown as { figma: { captureForDesign(o: Capture & { selector: string }): Promise<unknown> } }).figma.captureForDesign({ ...c, selector: "body" });
            }, c),
          ),
        ]);
        if (!response.ok()) throw new Error(`Figma refused the capture: ${response.status()} ${await response.text()}`);
      };

      const pool = slots(TABS);
      const tasks: Promise<void>[] = [];
      const failures: string[] = [];
      let overflow: Error | undefined;
      /** `body` in a fresh tab of `project`, one log line for it; its failure is the frame's, `overflow` the run's. */
      const run = (kind: "visit" | "capture", project: Project, page: string, body: (tab: Page) => Promise<string>) =>
        void tasks.push(
          pool(kind, async () => {
            const started = Date.now();
            const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
            const context = await browser.newContext(project.options);
            try {
              const note = await body(await context.newPage());
              console.log(`✓ ${project.name} ${page} ${secs()} (${note})`);
            } catch (e) {
              if (e === overflow) throw e;
              const why = e instanceof Error ? e.message : String(e);
              console.log(`✘ ${project.name} ${page} ${secs()}: ${why.split("\n")[0]}`);
              failures.push(`${project.name} ${page}: ${why}`);
            } finally {
              await context.close();
            }
          }),
        );

      const crawler = projects[0]!;
      const shapes = new Set<string>();
      const found: string[] = [];
      const visit = (page: string) =>
        run("visit", crawler, page, async tab => {
          const note = await load(tab, page);
          if (note === null) return "not html";
          const links = await deadline(LOAD)("links", tab.locator("a[href]").evaluateAll(as => as.map(a => (a as HTMLAnchorElement).href)));
          for (const link of links) {
            if (new URL(link).origin !== origin) continue;
            const next = pageOf(link, base);
            const shape = shapeOf(next);
            if (shapes.has(shape) || exclude.some(r => r.test(next))) continue;
            shapes.add(shape);
            found.push(next);
            if (found.length > LIMIT) throw (overflow ??= new Error(`more than ${LIMIT} pages: ${found.join(", ")}`));
            visit(next);
          }
          for (const project of projects.slice(1))
            run("capture", project, page, async tab => {
              const note = await load(tab, page);
              if (note === null) throw new Error(`not html at ${project.name}, html at ${crawler.name}`);
              await capture(tab, project, page);
              return note;
            });
          await capture(tab, crawler, page);
          return note;
        });
      for (const page of selectors.keys()) {
        shapes.add(shapeOf(page));
        found.push(page);
      }
      for (const page of [...found]) visit(page);
      for (let i = 0; i < tasks.length; i++) await tasks[i]; // tasks grows while awaited
      if (failures.length > 0) throw new Error(`not captured:\n${failures.join("\n")}`);
    });
  });
}
