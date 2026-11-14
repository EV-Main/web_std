import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collect, runCheck, writeCatalogues } from "../src/extract/index";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "i18n-extract-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const write = (files: Record<string, string | object>) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
};
const json = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));

const TSCONFIG = { compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } };
const SCOPE = 'import { scope } from "@evinvest/i18n";\n';

/** What `collect` reads under a tree of these files: `key → en`, or the errors. */
function check(files: Record<string, string | object>): Record<string, string> | string[] {
  write({ "tsconfig.json": TSCONFIG, ...files });
  const { entries, errors } = collect({ root });
  return errors.length > 0 ? errors : Object.fromEntries(entries.map(e => [e.key, e.en]));
}

describe("a key is read back to its scope", () => {
  it("through a barrel's export *, an alias import and a local const", () => {
    expect(
      check({
        "entities/gmb/index.ts": 'export * from "./model/scope";\n',
        "entities/gmb/model/scope.ts": `${SCOPE}export const gmbs = scope("gmbs");\n`,
        "features/add/ui.tsx":
          'import { gmbs } from "@/entities/gmb";\nconst add = gmbs.add;\n' +
          'export const Add = ({ t }) => {\n  const error = add.error;\n  return [t(add.hint, "Paste a link"), t(error.taken, "Already on the map")];\n};\n',
      }),
    ).toEqual({ "gmbs.add.hint": "Paste a link", "gmbs.add.error.taken": "Already on the map" });
  });

  it("through a renamed re-export and a namespace import", () => {
    expect(
      check({
        "a.ts": `${SCOPE}const root = scope("shell");\nexport { root as shell };\n`,
        "b.ts": 'export { shell as chrome } from "./a";\n',
        "c.ts": 'import * as keys from "./b";\nt(keys.chrome.signOut, "Sign out");\n',
      }),
    ).toEqual({ "shell.signOut": "Sign out" });
  });

  it("refuses what is not a static member chain", () => {
    expect(
      check({
        "x.ts":
          `${SCOPE}const s = scope("s");\nlet loose = s.a;\nconst pick = "a";\n` +
          't(s[pick], "A");\nt(loose, "B");\nt("s.c", "C");\nconst f = (k) => t(k, "D");\nt(scope(pick), "E");\nt(missing.x, "F");\n',
      }),
    ).toEqual([
      "x.ts:5: t() key uses computed access; a key is a member chain — use a closed table",
      "x.ts:6: t() key reads loose, which is not a const",
      'x.ts:7: t() key is a string; a key is a member chain off scope("…")',
      "x.ts:8: t() key reads k, a parameter",
      "x.ts:9: t() key calls scope() without one literal identifier",
      "x.ts:10: t() key reads missing, which is not declared in x.ts",
    ]);
  });
});

describe("writeCatalogues", () => {
  it("moves a renamed scope's entries by their English, and drops what is stale or ambiguous", () => {
    const ru = (en: string, t: string) => ({ en, t });
    write({
      "app.ts":
        `${SCOPE}const panel = scope("panel");\n` +
        't(panel.title, "Sites");\nt(panel.save, "Save");\nt(panel.again, "Save");\nt(panel.fresh, "New");\n',
      "messages/en/common.json": {},
      "messages/ru/common.json": { "sites.title": ru("Sites", "Сайты (вручную)") },
      "messages/ru/common.auto.json": {
        "sites.title": ru("Sites", "Сайты"),
        "sites.save": ru("Save", "Сохранить"),
        "sites.gone": ru("Gone", "Ушло"),
        "panel.fresh": ru("Fresh", "Свежее"),
      },
    });

    const lines = writeCatalogues(join(root, "messages"), collect({ root }).entries);

    expect(lines).toEqual([
      "en: 4 keys from 4 call sites",
      "ru/common.json: 1 entries",
      "  ru/common.json: moved sites.title → panel.title",
      "ru/common.auto.json: 1 entries",
      '  ru/common.auto.json: dropped stale panel.fresh ("Fresh")',
      "  ru/common.auto.json: moved sites.title → panel.title",
      '  ru/common.auto.json: dropped sites.save ("Save")',
      '  ru/common.auto.json: dropped sites.gone ("Gone")',
    ]);
    expect(json("messages/ru/common.auto.json")).toEqual({ "panel.title": ru("Sites", "Сайты") });
    expect(json("messages/en/common.json")).toEqual({
      "panel.again": "Save",
      "panel.fresh": "New",
      "panel.save": "Save",
      "panel.title": "Sites",
    });
  });
});

describe("runCheck", () => {
  const run = (...flags: string[]) => {
    const exit = vi.spyOn(process, "exit").mockImplementation(code => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    let threw: unknown = null;
    try {
      runCheck(["--root", root, ...flags]);
    } catch (e) {
      threw = e;
    }
    return { exit, threw, stderr: error.mock.calls.map(c => String(c[0])).join("\n") };
  };

  it("fails on a stale override even when the auto entry is valid, and passes once it is updated", () => {
    write({
      "app.ts": `${SCOPE}const shell = scope("shell");\nt(shell.signOut, "Log out");\n`,
      "messages/en/common.json": { "shell.signOut": "Log out" },
      "messages/ru/common.auto.json": { "shell.signOut": { en: "Log out", t: "Выйти" } },
      "messages/ru/common.json": { "shell.signOut": { en: "Sign out", t: "Выход" } },
    });

    const failed = run();
    expect(failed.exit).toHaveBeenCalledWith(1);
    expect(failed.stderr).toContain(
      'shell.signOut  [override stale] translated from "Sign out", source is now "Log out"',
    );

    vi.restoreAllMocks();
    write({ "messages/ru/common.json": { "shell.signOut": { en: "Log out", t: "Выход" } } });
    const passed = run();
    expect(passed.threw).toBe(null);
    expect(passed.exit).not.toHaveBeenCalled();
  });

  it("lists a key no layer translates, and fails on it only with --release", () => {
    write({
      "app.ts": `${SCOPE}const shell = scope("shell");\nt(shell.signOut, "Log out");\n`,
      "messages/en/common.json": { "shell.signOut": "Log out" },
      "messages/ru/common.auto.json": {},
      "messages/ru/common.json": {},
    });

    expect(run().exit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const failed = run("--release");
    expect(failed.exit).toHaveBeenCalledWith(1);
    expect(failed.stderr).toContain("untranslated (1): shell.signOut");
  });
});
