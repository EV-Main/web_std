import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { InputError, runRekey } from "../src/extract/index";

type Tree = Record<string, string>;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "i18n-rekey-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function plant(tree: Tree) {
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function read(dir = ""): Tree {
  const tree: Tree = {};
  for (const name of readdirSync(join(root, dir))) {
    const path = dir === "" ? name : `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) Object.assign(tree, read(path));
    else tree[path] = readFileSync(join(root, path), "utf8");
  }
  return tree;
}

/** Rekey `before`; the tree after it and every line it printed. */
function rekey(before: Tree): { after: Tree; log: string[] } {
  plant(before);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runRekey(["--root", root]);
  return { after: read(), log: log.mock.calls.map(([line]) => String(line)) };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const PAGE = `export const Page = ({ n }: { n: number }) => (
  <p title={t("hero.title", "Invest")}>
    {t(
      "hero.cta",
      \`Start\`,
      { n },
    )}
    {t("nav.start", "Start")}
    {t("hero.sub", "New sub")}
  </p>
);
`;

it("rewrites call sites and re-keys each locale's catalogue by English, reporting what it drops", () => {
  const { after, log } = rekey({
    "app/page.tsx": PAGE,
    "messages/en/common.json": json({ "hero.title": "Invest" }),
    "messages/de/common.json": json({
      "hero.cta": { en: "Start", t: "Starten" },
      "hero.sub": { en: "Old sub", t: "Alter Untertitel" },
      "hero.title": { en: "Invest", t: "Investieren" },
      "nav.start": { en: "Start", t: "Los" },
      "old.gone": { en: "Gone", t: "Weg" },
    }),
  });

  expect(after).toEqual({
    "app/page.tsx": `export const Page = ({ n }: { n: number }) => (
  <p title={t("Invest")}>
    {t(
      \`Start\`,
      { n },
    )}
    {t("Start")}
    {t("New sub")}
  </p>
);
`,
    "messages/de.json": json({ Invest: "Investieren", Start: "Starten" }),
    "messages/de.auto.json": json({ "//": "GENERATED — overrides go in de.json" }),
  });
  expect(log).toEqual([
    "4 t() calls rewritten in 1 files",
    "de: 2 translations → " + join(root, "messages", "de.json"),
    'de "hero.sub": dropped — translated "Old sub", the code says "New sub"',
    'de "Start": "hero.cta" → "Starten" kept, "nav.start" → "Los" dropped — give one a t.ctx by hand',
    'de "old.gone": dropped — no t() renders it',
  ]);
});

it("writes nothing when a call site is not t(key, English)", () => {
  const before = {
    "app/page.tsx": PAGE,
    "app/bad.ts": 'const k = "x";\nt(k, "X");\n',
    "messages/en/common.json": json({}),
    "messages/de/common.json": json({}),
  };

  expect(() => rekey(before)).toThrow(new InputError('nothing written:\n  app/bad.ts:2: not t("key", "English", …)'));
  expect(read()).toEqual(before);
});
