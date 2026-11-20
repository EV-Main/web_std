import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, STATE_DIR } from "./mcp";

/** A frame: a page at a project (a breakpoint), named `<project> <page>` in Figma; `col` is the project's index in the config. */
interface Frame {
  project: string;
  col: number;
  page: string;
}
const frameKey = (f: Frame) => `${f.project} ${f.page}`;

/** A page's column group: its first path segment. */
function groupOf(page: string): string {
  const u = new URL(page, "relative:/");
  return (u.protocol === "relative:" ? "" : u.origin) + "/" + (u.pathname.split("/")[1] ?? "");
}

const GAP = 200;
const POLLS = 60; // 5s apart; on a cold run the ~1 MB payloads were still processing 2 min after their upload was answered
const UPLOADS = 4; // at once: Figma takes ~0.5 a second per file however many are in flight
const UPLOAD = 180_000; // the POST of one payload; the slowest seen under contention took 44s
const CACHE = "figma-render cache"; // the page holding one frame per `<project> <payload sha256>`
const CACHE_PATH = join(STATE_DIR, "cache.json"); // per fileKey: the cache page's id and its frames' ids by key, so a run reads nothing from Figma before it uploads

interface Cache {
  page: string;
  frames: Record<string, string>;
}

/** The `captureForDesign({ captureId, endpoint })` an issuing `generate_figma_design` answers. */
export function issued(text: string): { captureId: string; endpoint: string } {
  const m = /captureForDesign\(\{ captureId: '([^']+)', endpoint: '([^']+)'/.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) throw new Error(`generate_figma_design: no captureForDesign({ captureId, endpoint }) in\n${text}`);
  return { captureId: m[1], endpoint: m[2] };
}

/** A polling `generate_figma_design`'s frame node id, or null while the capture is pending. */
export function polled(text: string): string | null {
  const done = /^The design has been added to your existing file: https:\/\/www\.figma\.com\/design\/\w+\?node-id=(\d+)-(\d+)\s/.exec(text);
  if (done) return `${done[1]}:${done[2]}`;
  if (/^Status for capture ID `[^`]+`: \*\*(pending|processing)\*\*/.test(text)) return null;
  throw new Error(`generate_figma_design: an unknown poll answer\n${text}`);
}

interface Placed {
  id: string;
  key: string;
  name: string;
  group: number;
  row: number;
  col: number;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parent: FigmaNode | null;
  children: FigmaNode[];
  appendChild(n: FigmaNode): void;
  clone(): FigmaNode;
  remove(): void;
  loadAsync(): Promise<void>;
  getSharedPluginData(namespace: string, key: string): string;
  setSharedPluginData(namespace: string, key: string, value: string): void;
}
declare const figma: {
  root: FigmaNode;
  getNodeByIdAsync(id: string): Promise<FigmaNode | null>;
  createPage(): FigmaNode;
  setCurrentPageAsync(page: FigmaNode): Promise<void>;
};

/**
 * Runs inside Figma (`use_figma`, as its source text). The frames are the cache page's (`cache`): new uploads, wherever
 * Figma put them, move onto it tagged with their key, and what no frame of this run uses is removed from it. Each frame
 * is cloned onto a new page named `name`, in a grid; a cache frame takes its first clone's name and place. `alone`, the
 * file's only page beside the cache. A render page of another `format` (another `arrange`) is removed.
 */
async function arrange({ name, frames, gap, alone, cache, format }: { name: string; frames: Placed[]; gap: number; alone: boolean; cache: string; format: string }): Promise<{ pageId: string; cache: string; kept: Record<string, string> }> {
  const byId = new Map<string, FigmaNode>();
  const missing: string[] = [];
  for (const f of frames) {
    if (byId.has(f.id)) continue;
    const n = await figma.getNodeByIdAsync(f.id);
    const tag = n?.getSharedPluginData("figma_render", "key");
    if (n === null || n.parent?.type !== "PAGE" || (tag !== "" && tag !== f.key)) missing.push(`${f.name} (${f.id})`);
    else byId.set(f.id, n);
  }
  if (missing.length > 0) throw new Error(`figma-render cache frames missing: ${missing.join(", ")}`);

  let store = figma.root.children.find(p => p.name === cache);
  if (store === undefined) {
    store = figma.createPage();
    store.name = cache;
  }
  await store.loadAsync();
  const homes = new Set<FigmaNode>();
  const kept: Record<string, string> = {};
  for (const f of frames) {
    const n = byId.get(f.id) as FigmaNode;
    if (n.parent !== store) {
      homes.add(n.parent as FigmaNode);
      store.appendChild(n);
    }
    n.setSharedPluginData("figma_render", "key", f.key);
    kept[f.key] = n.id;
  }
  for (const c of [...store.children]) if (!byId.has(c.id)) c.remove();

  const page = figma.createPage();
  page.name = name;
  await figma.setCurrentPageAsync(page);
  const projects = Math.max(...frames.map(f => f.col)) + 1;
  const widths: number[] = []; // per project column of each group
  const heights: number[][] = []; // per row of each group
  for (const f of frames) {
    const n = byId.get(f.id) as FigmaNode;
    const c = f.group * projects + f.col;
    widths[c] = Math.max(widths[c] ?? 0, n.width);
    const rows = heights[f.group] ?? (heights[f.group] = []);
    rows[f.row] = Math.max(rows[f.row] ?? 0, n.height);
  }
  const offset = (sizes: number[], i: number) => Array.from(sizes.slice(0, i)).reduce((sum: number, s) => sum + (s ?? 0) + gap, 0);
  const named = new Set<string>();
  for (const f of frames) {
    const cached = byId.get(f.id) as FigmaNode;
    const n = cached.clone();
    page.appendChild(n);
    n.name = f.name;
    n.x = offset(widths, f.group * projects + f.col) + f.group * 2 * gap; // groups three gaps apart
    n.y = offset(heights[f.group] as number[], f.row);
    if (named.has(f.id)) continue;
    named.add(f.id);
    cached.name = n.name;
    cached.x = n.x;
    cached.y = n.y;
  }
  for (const p of homes) await p.loadAsync();
  page.setSharedPluginData("figma_render", "format", format);
  const stale = (p: FigmaNode) => /^[0-9a-f]{7,40} \d{4}-\d{2}-\d{2}( dirty)?$/.test(p.name) && p.getSharedPluginData("figma_render", "format") !== format; // named as `pageName` names
  for (const p of [...figma.root.children]) if (p !== page && p !== store && (alone || stale(p) || (homes.has(p) && p.children.length === 0))) p.remove();
  return { pageId: page.id, cache: store.id, kept };
}

/** `<short sha> <YYYY-MM-DD>`, ` dirty` when the working tree is: the render is of it. */
function pageName(): string {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const d = new Date();
  const date = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, "0")).join("-");
  return `${git("rev-parse", "--short", "HEAD")} ${date}${git("status", "--porcelain") === "" ? "" : " dirty"}`;
}

/** Where a render goes: a new page of `file`, or all of the file named `name` in the Figma folder at URL `folder`. */
export type Target = { file: string } | { folder: string; name: string };

/** A Figma folder URL's plan and folder id: `/files/team/<team>/folder/<id>`, `/files/<org>/project/<id>`. */
export function folderOf(url: string): { planKey: string; id: string } {
  const m = /figma\.com\/files\/(?:team\/(\d+)|(\d+)(?:\/team\/\d+)?)\/(?:folder|project)\/(\d+)/.exec(url);
  if (m?.[3] === undefined) throw new Error(`not a Figma folder URL: ${url}`);
  return { planKey: m[1] !== undefined ? `team::${m[1]}` : `organization::${m[2]}`, id: m[3] };
}

/** The key of the file named `name` in `folder`, created there when there is none. */
async function fileIn(call: (tool: string, args: Record<string, unknown>) => Promise<string>, folder: string, name: string): Promise<string> {
  const { planKey, id } = folderOf(folder);
  // MCP has no tool that lists a folder; the REST API does, under a personal access token
  const token = process.env["FIGMA_TOKEN"];
  if (!token) throw new Error("--folder needs FIGMA_TOKEN: a Figma personal access token with folders:read");
  const res = await fetch(`https://api.figma.com/v2/folders/${id}/files`, { headers: { "x-figma-token": token } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Figma folder ${id}: ${res.status} ${body}`);
  const named = (JSON.parse(body) as { files: { key: string; name: string }[] }).files.filter(f => f.name === name);
  if (named.length > 1) throw new Error(`Figma folder ${id}: ${named.length} files named "${name}"`);
  if (named[0] !== undefined) return named[0].key;
  const created = await call("create_new_file", { fileName: name, planKey, projectId: id, editorType: "design" });
  const { file_key } = JSON.parse(created) as { file_key?: unknown };
  if (typeof file_key !== "string") throw new Error(`create_new_file: no file_key in ${created}`);
  return file_key;
}

/**
 * Runs the suite (`run`, given `FIGMA_ISSUER`), which posts each frame's payload. A payload whose key (`<project>
 * <sha256>`) the file's cache page already holds is not uploaded, nor one this run already took; the others are
 * uploaded `UPLOADS` at once and polled for their frame. Then one `use_figma` clones every frame onto a new page of the
 * `target` Figma file and prints its link; it is the run's only call Figma counts toward its rate limit. Answers the exit code.
 */
export async function render(target: Target, run: (issuer: string) => Promise<number>): Promise<number> {
  const name = pageName();
  const call = await connect();
  const file = "file" in target ? target.file : await fileIn(call, target.folder, target.name);
  const promptId = randomUUID();
  const caches = () => (existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {}) as Record<string, Cache>;
  const known = caches()[file];
  /** This file's entry as `cache`, read anew: a run on another file may have written the others since. */
  const saveCache = (cache: Cache | undefined) => {
    const all = caches();
    if (cache === undefined) delete all[file];
    else all[file] = cache;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(all, null, 2));
  };

  let free = UPLOADS;
  const queue: (() => void)[] = [];
  const slot = async <T>(task: () => Promise<T>): Promise<T> => {
    if (free > 0) free--;
    else await new Promise<void>(go => queue.push(go));
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next === undefined) free++;
      else next();
    }
  };
  let firstUpload: number | undefined;
  /** A payload into Figma: its frame's node id, or why not. */
  const upload = async (payload: string): Promise<{ id: string; secs: number } | { error: string }> => {
    try {
      let started = 0;
      const captureId = await slot(async () => {
        started = Date.now();
        firstUpload ??= started;
        const c = issued(await call("generate_figma_design", { fileKey: file, promptId, ...(known === undefined ? {} : { nodeId: known.page }) }));
        const res = await fetch(c.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ captureId: c.captureId, payload, captureIndex: 0 }),
          signal: AbortSignal.timeout(UPLOAD),
        });
        const answer = await res.text();
        if (res.status === 409 && answer.includes("CAPTURE_ID_ALREADY_SUBMITTED")) return c.captureId; // seen on the ~1 MB payloads: an earlier attempt of this POST got there; the poll says what became of it
        if (!res.ok) throw new Error(`upload: ${res.status} ${answer}`);
        const { error } = JSON.parse(answer) as { error?: unknown };
        if (error !== undefined) throw new Error(`upload: ${JSON.stringify(error)}`);
        return c.captureId;
      });
      let text = "";
      for (let round = 0; round < POLLS; round++) {
        if (round > 0) await sleep(5_000);
        text = await call("generate_figma_design", { fileKey: file, captureId });
        const id = polled(text);
        if (id !== null) return { id, secs: (Date.now() - started) / 1000 };
      }
      return { error: `pending after ${POLLS} polls: ${text.split("\n")[0]}` };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const frames: Frame[] = [];
  const keys = new Map<string, string>(); // frameKey → payload key
  const firstPage = new Map<string, string>(); // payload key → the page it was first posted for
  const uploads = new Map<string, Promise<{ id: string; secs: number } | { error: string }>>();
  const issuer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        const { project, col, page, payload } = JSON.parse(body) as Frame & { payload: unknown }; // payload: capture.js's own JSON text
        if (typeof project !== "string" || typeof col !== "number" || typeof page !== "string" || typeof payload !== "string")
          throw new Error(`FIGMA_ISSUER: want { project, col, page, payload }, got ${body.slice(0, 200)}`);
        const f = { project, col, page };
        if (keys.has(frameKey(f))) throw new Error(`FIGMA_ISSUER: ${frameKey(f)} posted twice`);
        const other = frames.find(g => g.project === project && g.col !== col);
        if (other !== undefined) throw new Error(`FIGMA_ISSUER: ${project} at col ${col}, before at ${other.col}`);
        frames.push(f);
        const key = `${project} ${createHash("sha256").update(payload).digest("hex")}`;
        keys.set(frameKey(f), key);
        const same = firstPage.get(key);
        let note: string;
        if (same !== undefined) note = `≡ ${same}`;
        else {
          firstPage.set(key, page);
          if (known?.frames[key] !== undefined) note = "cached";
          else {
            uploads.set(key, upload(payload));
            note = "uploaded";
          }
        }
        res.writeHead(200, { "content-type": "text/plain" }).end(note);
      } catch (e) {
        res.writeHead(500).end(e instanceof Error ? e.message : String(e));
      }
    });
  });
  await new Promise<void>(up => issuer.listen(0, "127.0.0.1", up));
  const status = await run(`http://127.0.0.1:${(issuer.address() as AddressInfo).port}/`).finally(() => issuer.close());
  if (frames.length === 0) {
    if (status !== 0) return status;
    throw new Error("the suite asked for no frame: is it run on its first project?");
  }

  const done = new Map<string, { id: string; secs: number } | { error: string }>();
  for (const [key, u] of uploads) done.set(key, await u);
  if (firstUpload !== undefined) {
    const slowest = [...done].flatMap(([key, d]) => ("id" in d ? [{ key, secs: d.secs }] : [])).sort((a, b) => b.secs - a.secs)[0];
    console.error(`uploads: ${uploads.size} in ${((Date.now() - firstUpload) / 1000).toFixed(1)}s${slowest === undefined ? "" : `, slowest ${slowest.secs.toFixed(1)}s (${slowest.key.split(" ")[0]} ${firstPage.get(slowest.key)})`}`);
  }

  const failed: string[] = [];
  const groups = [...new Set(frames.map(f => groupOf(f.page)))].sort();
  const pages = [...new Set(frames.map(f => f.page))].sort();
  const cols = [...new Set(frames.map(f => f.col))].sort((a, b) => a - b);
  const placed: Placed[] = frames.flatMap(f => {
    const key = keys.get(frameKey(f)) as string;
    const d = done.get(key);
    const id = d === undefined ? known?.frames[key] : "id" in d ? d.id : undefined;
    if (id === undefined) {
      failed.push(`✘ ${frameKey(f)} not captured: ${d !== undefined && "error" in d ? d.error : `${firstPage.get(key)}'s upload failed`}`);
      return [];
    }
    const group = groupOf(f.page);
    return [{ id, key, name: frameKey(f), group: groups.indexOf(group), row: pages.filter(p => groupOf(p) === group).indexOf(f.page), col: cols.indexOf(f.col) }];
  });

  if (placed.length > 0) {
    let text: string;
    try {
      text = await call("use_figma", {
        fileKey: file,
        description: `Clone the ${placed.length} cached frames onto page "${name}" in a grid, and prune the cache page "${CACHE}"`,
        code: `return await (${arrange.toString()})(${JSON.stringify({ name, frames: placed, gap: GAP, alone: !("file" in target), cache: CACHE, format: createHash("sha256").update(arrange.toString()).digest("hex").slice(0, 12) })});`,
      });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("figma-render cache frames missing")) throw e;
      saveCache(undefined); // the next run uploads every frame again
      console.error(`${e.message}\n${CACHE_PATH}: ${file} dropped`);
      return 1;
    }
    const { pageId, cache, kept } = JSON.parse(text) as { pageId?: unknown; cache?: unknown; kept?: unknown };
    if (typeof pageId !== "string" || !/^\d+:\d+$/.test(pageId) || typeof cache !== "string" || typeof kept !== "object" || kept === null) throw new Error(`use_figma: no page, cache page or kept frames in ${text}`);
    saveCache({ page: cache, frames: kept as Record<string, string> });
    console.log(`https://www.figma.com/design/${file}?node-id=${pageId.replace(":", "-")}`);
  }
  for (const line of failed) console.error(line);
  return failed.length > 0 ? 1 : status;
}
