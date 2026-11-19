import type { Browser, BrowserContextOptions, Page, TestType } from "@playwright/test";

/**
 * `@evinvest/figma-render` — a site's pages, as its own Playwright suite reaches them, serialized into Figma
 * frames through `generate_figma_design`'s capture script. Types only from `@playwright/test`: the caller passes
 * its own `test`, so this module loads nothing at run time and cannot end up with a second copy of the runner
 * (Playwright refuses to run with two).
 */

/** The describe the suite sits in; the bin greps by it. */
export const FIGMA_SUITE = "@figma";

/**
 * Waits until a selector's subtree is what a visitor sees: web fonts applied,
 * every image in it loaded (lazy ones forced), the network idle, and every
 * finite animation finished — `animations: "disabled"` freezes CSS animations,
 * not ones driven through the Web Animations API.
 */
export async function settle(page: Page, selector: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.locator(selector).evaluate(root =>
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
  );
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter(a => (a.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
        .every(a => a.playState === "finished" || a.playState === "idle"),
    undefined,
    { timeout: 10_000 },
  );
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
const CONCURRENCY = 4; // pages captured at once

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

/** Where the bin issues capture ids: `FIGMA_ISSUER`, a POST of `{ project, page }` answered with a `Capture`. */
async function issue(issuer: string, project: string, page: string): Promise<Capture> {
  const res = await fetch(issuer, { method: "POST", body: JSON.stringify({ project, page }) });
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
 * them, crawled breadth-first on that project and one frame per shape (`shapeOf`), then each captured at every project.
 * Without `FIGMA_ISSUER` (the bin's) it is skipped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runner's fixture types are the caller's; only `browser` is read
export function defineFigmaSuite({ test }: { test: TestType<any, any> }, sections: readonly Section[], { hide = [], exclude = [] }: FigmaSuiteOptions = {}): void {
  test.describe(FIGMA_SUITE, () => {
    test("crawl", async ({ browser }: { browser: Browser }, info: Info) => {
      const issuer = process.env["FIGMA_ISSUER"];
      if (issuer === undefined) return test.skip(true, "run by evinvest-figma-render");
      const [first] = info.config.projects;
      if (first === undefined || info.project.name !== first.name) return test.skip(true, "the crawl runs once, on the first project");
      info.setTimeout(0); // as long as the site is large; LIMIT bounds it

      // a context per visit: a page is what its URL alone shows, never what the one before it left in storage
      const contexts = info.config.projects.map(p => ({
        project: p.name,
        options: {
          ...(Object.fromEntries(CONTEXT_KEYS.filter(k => k in p.use).map(k => [k, p.use[k]])) as BrowserContextOptions),
          bypassCSP: true, // capture.js and its POST to Figma
          reducedMotion: "reduce",
        } satisfies BrowserContextOptions,
      }));
      const base = first.use["baseURL"];
      if (typeof base !== "string") throw new Error(`project ${first.name}: no baseURL to crawl from`);

      const selectors = new Map<string, string[]>();
      for (const s of sections) {
        const page = pageOf(s.url, base);
        selectors.set(page, [...(selectors.get(page) ?? []), s.selector]);
      }
      const open = async (options: BrowserContextOptions, page: string) => {
        const tab = await (await browser.newContext(options)).newPage();
        const res = await tab.goto(page);
        if (res === null) throw new Error(`${page}: no response`);
        for (const selector of selectors.get(page) ?? []) await tab.locator(selector).waitFor({ state: "attached" }); // attached: a section the breakpoint hides is still the page's
        await settle(tab, "body");
        return { tab, res };
      };

      const crawler = contexts[0]!.options;
      const shapes = new Set<string>();
      const queue = [...selectors.keys()];
      for (const page of queue) shapes.add(shapeOf(page));
      const pages: string[] = [];
      while (queue.length > 0) {
        const page = queue.shift() as string;
        const { tab, res } = await open(crawler, page);
        const html = (res.headers()["content-type"] ?? "").startsWith("text/html"); // else a link to a file or an API
        const links = html ? await tab.locator("a[href]").evaluateAll(as => as.map(a => (a as HTMLAnchorElement).href)) : [];
        await tab.context().close();
        if (html) pages.push(page);
        for (const link of links) {
          const u = new URL(link);
          if (u.origin !== new URL(base).origin) continue;
          const found = pageOf(link, base);
          const shape = shapeOf(found);
          if (shapes.has(shape) || exclude.some(r => r.test(found))) continue;
          shapes.add(shape);
          queue.push(found);
        }
        if (pages.length + queue.length > LIMIT) throw new Error(`more than ${LIMIT} pages: ${[...pages, ...queue].join(", ")}`);
      }

      const jobs = pages.flatMap(page => contexts.map(c => ({ ...c, page })));
      const capture = async ({ project, options, page }: (typeof jobs)[number]) => {
        const { tab } = await open(options, page);
        if (hide.length > 0) await tab.addStyleTag({ content: `${hide.join(", ")} { display: none !important; }` });
        await tab.addScriptTag({ url: CAPTURE_JS });
        const c = await issue(issuer, project, page);
        const submitted = tab.waitForResponse(r => r.url() === c.endpoint && r.request().method() === "POST", { timeout: 120_000 }); // a capture uploads up to 50 MB
        // Its promise never settles; the submit's response is the end.
        await tab.evaluate(c => {
          void (window as unknown as { figma: { captureForDesign(o: Capture & { selector: string }): Promise<unknown> } }).figma.captureForDesign({ ...c, selector: "body" });
        }, c);
        const response = await submitted;
        if (!response.ok()) throw new Error(`${project} ${page}: Figma refused the capture: ${response.status()} ${await response.text()}`);
        await tab.context().close();
      };
      const failures: string[] = [];
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          for (let job = jobs.shift(); job !== undefined; job = jobs.shift())
            await capture(job).catch((e: unknown) => void failures.push(`${job!.project} ${job!.page}: ${e instanceof Error ? e.message : String(e)}`));
        }),
      );
      if (failures.length > 0) throw new Error(`not captured:\n${failures.join("\n")}`);
    });
  });
}
