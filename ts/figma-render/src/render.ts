import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Capture } from "./index";
import { connect } from "./mcp";

/** A frame: a page at a project (a breakpoint), named `<project> <page>` in Figma. */
interface Frame {
  project: string;
  page: string;
}
const frameKey = (f: Frame) => `${f.project} ${f.page}`;

const GAP = 200;
const POLLS = 10;

/** The `captureForDesign({ captureId, endpoint })` an issuing `generate_figma_design` answers. */
export function issued(text: string): Capture {
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
  name: string;
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
  remove(): void;
  loadAsync(): Promise<void>;
}
declare const figma: {
  root: FigmaNode;
  getNodeByIdAsync(id: string): Promise<FigmaNode | null>;
  createPage(): FigmaNode;
  setCurrentPageAsync(page: FigmaNode): Promise<void>;
};

/**
 * Runs inside Figma (`use_figma`, as its source text): the frames onto one page named `name`, in a grid; `alone`, the
 * file's only page. Captures land wherever Figma puts them, so the page is the first frame's when it holds nothing else.
 */
async function arrange({ name, frames, gap, alone }: { name: string; frames: Placed[]; gap: number; alone: boolean }): Promise<{ pageId: string }> {
  const nodes: FigmaNode[] = [];
  for (const f of frames) {
    const n = await figma.getNodeByIdAsync(f.id);
    if (n?.parent?.type !== "PAGE") throw new Error(`frame ${f.id}: ${n === null ? "missing" : `under a ${n.parent?.type}`}`);
    nodes.push(n);
  }
  const ours = new Set(nodes);
  const homes = [...new Set(nodes.map(n => n.parent as FigmaNode))];
  for (const p of homes) await p.loadAsync();
  const onlyOurs = new Set(homes.filter(p => p.children.every(c => ours.has(c))));
  const first = homes[0] as FigmaNode;
  const page = onlyOurs.has(first) ? first : figma.createPage();
  page.name = name;
  await figma.setCurrentPageAsync(page);

  const widths: number[] = [];
  const heights: number[] = [];
  frames.forEach((f, i) => {
    const n = nodes[i] as FigmaNode;
    widths[f.col] = Math.max(widths[f.col] ?? 0, n.width);
    heights[f.row] = Math.max(heights[f.row] ?? 0, n.height);
  });
  const offset = (sizes: number[], i: number) => sizes.slice(0, i).reduce((sum, s) => sum + s + gap, 0);
  frames.forEach((f, i) => {
    const n = nodes[i] as FigmaNode;
    n.name = f.name;
    page.appendChild(n);
    n.x = offset(widths, f.col);
    n.y = offset(heights, f.row);
  });
  for (const p of [...figma.root.children]) if (p !== page && (alone || (onlyOurs.has(p) && p.children.length === 0))) p.remove();
  return { pageId: page.id };
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
 * Runs the suite (`run`, given `FIGMA_ISSUER`) with a capture id issued for each frame it asks one for, polls each
 * for its frame in the `target` Figma file, lays them out on one page and prints its link. Only `use_figma` counts
 * toward Figma's rate limit. Answers the exit code.
 */
export async function render(target: Target, run: (issuer: string) => Promise<number>): Promise<number> {
  const name = pageName();
  const call = await connect();
  const file = "file" in target ? target.file : await fileIn(call, target.folder, target.name);
  const promptId = randomUUID();
  const frames: Frame[] = [];
  const captures = new Map<string, Capture>();
  const issuer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        const f = JSON.parse(body) as Frame;
        if (typeof f.project !== "string" || typeof f.page !== "string") throw new Error(`FIGMA_ISSUER: want { project, page }, got ${body}`);
        if (captures.has(frameKey(f))) throw new Error(`FIGMA_ISSUER: ${frameKey(f)} asked twice`);
        const c = issued(await call("generate_figma_design", { fileKey: file, promptId }));
        frames.push(f);
        captures.set(frameKey(f), c);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(c));
      })().catch((e: unknown) => res.writeHead(500).end(e instanceof Error ? e.message : String(e)));
    });
  });
  await new Promise<void>(up => issuer.listen(0, "127.0.0.1", up));
  const status = await run(`http://127.0.0.1:${(issuer.address() as AddressInfo).port}/`).finally(() => issuer.close());
  if (frames.length === 0) {
    if (status !== 0) return status;
    throw new Error("the suite asked for no frame: is it run on its first project?");
  }

  const nodes = new Map<string, string>();
  const pending = new Map<string, string>();
  for (let round = 0; round < POLLS && nodes.size < captures.size; round++) {
    if (round > 0) await sleep(5_000);
    for (const [key, { captureId }] of captures) {
      if (nodes.has(key)) continue;
      const text = await call("generate_figma_design", { fileKey: file, captureId });
      const node = polled(text);
      if (node === null) {
        pending.set(key, text.split("\n")[0] as string);
      } else {
        nodes.set(key, node);
        pending.delete(key);
      }
    }
  }

  if (nodes.size > 0) {
    const pages = [...new Set(frames.map(f => f.page))];
    const projects = [...new Set(frames.map(f => f.project))];
    const placed: Placed[] = frames.flatMap(f => {
      const id = nodes.get(frameKey(f));
      return id === undefined ? [] : [{ id, name: frameKey(f), row: pages.indexOf(f.page), col: projects.indexOf(f.project) }];
    });
    const text = await call("use_figma", {
      fileKey: file,
      description: `Name the ${placed.length} captured frames and lay them out on page "${name}"`,
      code: `return await (${arrange.toString()})(${JSON.stringify({ name, frames: placed, gap: GAP, alone: !("file" in target) })});`,
    });
    const { pageId } = JSON.parse(text) as { pageId?: unknown };
    if (typeof pageId !== "string" || !/^\d+:\d+$/.test(pageId)) throw new Error(`use_figma: no page id in ${text}`);
    console.log(`https://www.figma.com/design/${file}?node-id=${pageId.replace(":", "-")}`);
  }
  for (const [key, text] of pending) console.error(`✘ ${key} not captured: ${text}`);
  return pending.size > 0 ? 1 : status;
}
