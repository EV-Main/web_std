import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collect, InputError, messageSlices, runSlices, serialiseSlices, type TableRule } from "../src/extract/index";
import { messageId } from "../src/registry";

// A miniature App Router app: a layout with a client nav, a client error
// boundary, a wallet page reaching client leaves three ways (a client
// component, a plain module it imports, an `import()`), and a table of tips
// two pages pick rows out of, beside a heading the table module renders outside it. Each test works on its own copy, so a test that
// breaks the app breaks nothing else.
const FIXTURE = fileURLToPath(new URL("./fixtures/slices-app", import.meta.url));
const WALLET = "app/[locale]/wallet/page.tsx";
const INVEST = "app/[locale]/invest/page.tsx";
const TIPS: TableRule = { table: "tips/copy.ts", ignore: ["tips/catalog.ts"] };
const INVEST_TIP = messageId("tips", "Invest tip");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "i18n-slices-"));
  cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const write = (path: string, text: string) => writeFileSync(join(root, path), text);

describe("messageSlices on a clean app", () => {
  it("puts the ids of layouts and boundary files in the shell", () => {
    const { slices, errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([]);
    expect(slices.shell).toEqual(["Home", "Something went wrong"]);
  });

  it("gives a page the ids of its client tree, minus the shell", () => {
    const { slices } = messageSlices({ root, tables: [TIPS] });

    // Panel: a "use client" component the server page renders.
    // Helper: a module with no directive, client because panel imports it.
    // Lazy: reached through `import("./lazy")`.
    // Wallet tip*: the row the page names with anchor="wallet.x".
    expect(slices.routes[WALLET]).toEqual(["About", "Helper", "Lazy", "Panel", "Tips", "Wallet tip", "Wallet tip body"]);
  });

  it("selects only the table rows whose name a page uses", () => {
    const { slices } = messageSlices({ root, tables: [TIPS] });

    expect(slices.routes[INVEST]).toEqual(["About", "Invest tip body", "Tips", INVEST_TIP]);
    expect(slices.routes[WALLET]).not.toContain(INVEST_TIP);
  });

  it("carries a row's English the table module also renders outside the table", () => {
    write("tips/copy.ts", `${readFileSync(join(root, "tips/copy.ts"), "utf8")}export const walletHeading = (t: Translate) => t("Wallet tip");\n`);

    const { slices } = messageSlices({ root, tables: [TIPS] });

    expect(slices.routes[INVEST]).toContain("Wallet tip");
  });

  it("does not follow an import type into a client file", () => {
    const { slices } = messageSlices({ root, tables: [TIPS] });

    expect(slices.routes[WALLET]).not.toContain("Type only");
    expect(slices.serverOnly).toContain("Type only");
  });

  it("files server t() calls and unimported files under serverOnly", () => {
    const { slices } = messageSlices({ root, tables: [TIPS] });

    expect(slices.serverOnly).toEqual(["EV", "Orphan", "Type only", "Wallet"]);
  });

  it("treats a \"use client\" after a leading comment as a boundary", () => {
    // nav.tsx opens with a block comment; were the directive missed, "Home"
    // would fall to serverOnly and render English in every locale.
    const { slices } = messageSlices({ root, tables: [TIPS] });

    expect(slices.shell).toContain("Home");
    expect(slices.serverOnly).not.toContain("Home");
  });

  it("does not treat a \"use client\" after an import as a boundary", () => {
    write(
      "shell/nav.tsx",
      'import { useT } from "@evinvest/i18n/react";\n"use client";\nexport function Nav() {\n  const t = useT();\n  return t("Home");\n}\n',
    );

    const { slices } = messageSlices({ root, tables: [TIPS] });

    expect(slices.shell).toEqual(["Something went wrong"]);
    expect(slices.serverOnly).toContain("Home");
  });

  it("carries every row of a table that has no rule", () => {
    const { slices, errors } = messageSlices({ root });

    expect(errors).toEqual([]);
    expect(slices.routes[INVEST]).toEqual(["About", "Invest tip body", "Tips", "Wallet tip", "Wallet tip body", INVEST_TIP]);
  });

  it("accounts for every id collect reads, in exactly one of shell, routes or serverOnly", () => {
    const { slices } = messageSlices({ root, tables: [TIPS] });
    const everyId = collect({ root }).entries.map(e => e.id).sort();

    const routed = Object.values(slices.routes).flat();
    const carried = [...slices.shell, ...routed];

    expect([...new Set([...carried, ...slices.serverOnly])].sort()).toEqual(everyId);
    expect(slices.serverOnly.filter(id => carried.includes(id))).toEqual([]);
    expect(routed.filter(id => slices.shell.includes(id))).toEqual([]);
  });
});

// `collect` and the slice generator read call sites through one shared module
// (extract/calls.ts); these pin what `collect` gives on the same app.
describe("collect", () => {
  it("reads every t() call under the root, with its English and location", () => {
    const { entries, errors } = collect({ root });

    expect(errors).toEqual([]);
    expect(entries.map(e => e.id).sort()).toEqual([
      "About",
      "EV",
      "Helper",
      "Home",
      "Invest tip body",
      "Lazy",
      "Orphan",
      "Panel",
      "Something went wrong",
      "Tips",
      "Type only",
      "Wallet",
      "Wallet tip",
      "Wallet tip body",
      INVEST_TIP,
    ]);
    expect(entries.find(e => e.id === "Home")).toEqual({ id: "Home", en: "Home", where: "shell/nav.tsx:7" });
  });

  it("reports the same unreadable call sites as the slice generator", () => {
    write("scripts/bad.ts", 'const k = "x";\nt(k);\nt.ctx(k, "X");\n');

    expect(messageSlices({ root, tables: [TIPS] }).errors).toEqual(collect({ root }).errors);
  });
});

describe("messageSlices on what the graph cannot account for", () => {
  it("reports a path alias that resolves to no file", () => {
    write(INVEST, 'import { Gone } from "@/components/gone";\nexport default () => <Gone />;\n');

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([
      `${INVEST}:1: cannot resolve "@/components/gone" — a local import the graph cannot follow`,
    ]);
  });

  it("reports a relative import that resolves to no file", () => {
    write(INVEST, 'import { Gone } from "./gone";\nexport default () => <Gone />;\n');

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([`${INVEST}:1: cannot resolve "./gone" — a local import the graph cannot follow`]);
  });

  it("reports an import() of a computed path in a file a page reaches", () => {
    write("components/dynamic.ts", 'const path = "./lazy";\nexport const load = () => import(path);\n');
    write(INVEST, 'import { load } from "@/components/dynamic";\nexport default () => { void load; return null; };\n');

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual(["components/dynamic.ts:2: import() of a non-literal path cannot be followed"]);
  });

  it("reports a table rule whose module holds no table", () => {
    const { errors } = messageSlices({ root, tables: [{ table: "components/helper.ts" }] });

    expect(errors).toEqual([
      "table rule for components/helper.ts: no top-level const in it is an object literal of t() copy",
    ]);
  });

  it("reports an @/ alias when there is no tsconfig to map it", () => {
    rmSync(join(root, "tsconfig.json"));

    const { errors } = messageSlices({ root, tables: [TIPS] });

    // Without the error, Home, Panel, Helper and Lazy fell to serverOnly silently.
    expect(errors).toContain(
      'app/[locale]/layout.tsx:3: cannot resolve "@/shell/nav" — a local import the graph cannot follow' +
        " (it is an alias, not a package, and no tsconfig was read to map it)",
    );
  });

  it("reports an @/ alias the tsconfig's paths do not map", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "#lib/*": ["./components/*"] } } }));

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toContain(
      'app/[locale]/layout.tsx:3: cannot resolve "@/shell/nav" — a local import the graph cannot follow' +
        " (it is an alias, not a package, and the tsconfig's paths do not map it)",
    );
  });

  it("reports ~/ and # specifiers nothing maps", () => {
    write(INVEST, 'import { A } from "~/components/a";\nimport { B } from "#components/b";\nexport default () => <A />;\n');

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([
      `${INVEST}:1: cannot resolve "~/components/a" — a local import the graph cannot follow` +
        " (it is an alias, not a package, and the tsconfig's paths do not map it)",
      `${INVEST}:2: cannot resolve "#components/b" — a local import the graph cannot follow` +
        " (it is an alias, not a package, and the tsconfig's paths do not map it)",
    ]);
  });

  it("follows a # specifier the tsconfig's paths map", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"], "#lib/*": ["./components/*"] } } }));
    write(INVEST, 'import { Panel } from "#lib/panel";\nexport default () => <Panel />;\n');

    const { slices, errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([]);
    expect(slices.routes[INVEST]).toEqual(["Helper", "Lazy", "Panel"]);
  });

  it("stops at scoped and bare package imports without an error", () => {
    rmSync(join(root, "tsconfig.json"));
    write(
      INVEST,
      'import { useState } from "react";\nimport { x } from "@scope/pkg";\nimport { y } from "@scope/pkg/sub";\nexport default () => null;\n',
    );

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors.filter(error => error.startsWith(INVEST))).toEqual([]);
  });
});

// Import-scan errors count only where an entry reaches; t() errors count
// anywhere under the root, as they do for `collect`. `components/x.test.ts`
// stands for a test file no entry imports.
describe("messageSlices on a file no entry reaches", () => {
  const UNREACHED = "components/x.test.ts";

  it("ignores an import() of a computed path and leaves the slices as they were", () => {
    const before = messageSlices({ root, tables: [TIPS] }).slices;
    write(UNREACHED, 'const s = "./a";\nawait import(s);\n');

    const { slices, errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([]);
    expect(slices).toEqual(before);
  });

  it("ignores a require() and an export of a computed path", () => {
    write(UNREACHED, 'const s = "./a";\nconst m = require(s);\nexport * from s;\n');

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([]);
  });

  it("ignores a relative import that resolves to no file", () => {
    write(UNREACHED, 'import { gone } from "./gone";\nvoid gone;\n');

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([]);
  });

  it("still reports a t() whose English is not a string literal", () => {
    write(UNREACHED, 'const k = "x";\nt(k);\n');

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual([`${UNREACHED}:2: t() English is not a string literal`]);
  });
});

describe("messageSlices on a file only the shell reaches", () => {
  it("reports an import() of a computed path", () => {
    write("shell/loader.ts", 'const spec = "./nav";\nexport const loadNav = () => import(spec);\n');
    write(
      "app/[locale]/error.tsx",
      '"use client";\nimport { useT } from "@evinvest/i18n/react";\nimport { loadNav } from "@/shell/loader";\n\n' +
        'export default function ErrorBoundary() {\n  const t = useT();\n  void loadNav;\n' +
        '  return <p>{t("Something went wrong")}</p>;\n}\n',
    );

    const { errors } = messageSlices({ root, tables: [TIPS] });

    expect(errors).toEqual(["shell/loader.ts:2: import() of a non-literal path cannot be followed"]);
  });
});

describe("runSlices", () => {
  const OUT = () => join(root, "i18n-slices.json");
  const CONFIG = () => join(root, "slices.config.json");

  /** `process.exit` as a throw, so a failing run stops where the bin would. */
  const exits = () =>
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    });

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("writes the slices with the generated header", () => {
    runSlices(["--root", root, "--config", CONFIG()]);

    const written = JSON.parse(readFileSync(OUT(), "utf8")) as Record<string, unknown>;
    expect(written["//"]).toMatch(/^GENERATED by evinvest-i18n-slices/);
    expect(written["shell"]).toEqual(["Home", "Something went wrong"]);
  });

  it("passes --check when the file matches the code", () => {
    runSlices(["--root", root, "--config", CONFIG()]);
    const exit = exits();

    runSlices(["--root", root, "--config", CONFIG(), "--check"]);

    expect(exit).not.toHaveBeenCalled();
  });

  it("fails --check when the code has drifted from the file", () => {
    runSlices(["--root", root, "--config", CONFIG()]);
    write("components/lazy.tsx", 'export default () => t("Lazy, renamed");\n');
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runSlices(["--root", root, "--config", CONFIG(), "--check"])).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("is out of date with the code"));
  });

  it("fails --check when there is no file", () => {
    const exit = exits();
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runSlices(["--root", root, "--config", CONFIG(), "--check"])).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(existsSync(OUT())).toBe(false);
  });

  it("exits non-zero without writing when the graph has errors", () => {
    write(INVEST, 'import "./gone";\n');
    exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runSlices(["--root", root, "--config", CONFIG()])).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot resolve "./gone"'));
    expect(existsSync(OUT())).toBe(false);
  });

  it("rejects an unknown top-level field in the config", () => {
    write("slices.config.json", JSON.stringify({ tables: [TIPS], table: "tips/copy.ts" }));

    expect(() => runSlices(["--root", root, "--config", CONFIG()])).toThrow("unknown field table");
    expect(() => runSlices(["--root", root, "--config", CONFIG()])).toThrow(InputError);
  });

  it("rejects an unknown field in a table rule", () => {
    write("slices.config.json", JSON.stringify({ tables: [{ ...TIPS, keys: ["tips.*.title"] }] }));

    expect(() => runSlices(["--root", root, "--config", CONFIG()])).toThrow("tables[0]: unknown field keys");
    expect(() => runSlices(["--root", root, "--config", CONFIG()])).toThrow(InputError);
  });

  it("serialises exactly what it writes", () => {
    runSlices(["--root", root, "--config", CONFIG()]);
    const { slices } = messageSlices({ root, tables: [TIPS] });

    expect(readFileSync(OUT(), "utf8")).toBe(serialiseSlices(slices));
  });
});

describe("runSlices arguments", () => {
  const OUT = () => join(root, "i18n-slices.json");
  const CONFIG = () => join(root, "slices.config.json");
  const COMMITTED = "committed by hand\n";

  beforeEach(() => {
    write("i18n-slices.json", COMMITTED);
  });

  it.each([["--help"], ["-h"]])("prints the usage for %s and writes nothing", flag => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    runSlices(["--root", root, flag]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Usage: evinvest-i18n-slices/));
    expect(exit).not.toHaveBeenCalled();
    expect(readFileSync(OUT(), "utf8")).toBe(COMMITTED);
  });

  it.each([
    ["an unknown flag", ["--root", "ROOT", "--bogus"], "unknown flag --bogus"],
    ["--root without a value", ["--out", "OUT", "--root"], "--root needs a value"],
    ["--out followed by --check", ["--root", "ROOT", "--out", "--check"], "--out needs a value"],
  ])("rejects %s before touching the committed file", (_, argv, message) => {
    // `it.each` rows are built before `root` exists, so they name it by placeholder.
    const args = argv.map(arg => (arg === "ROOT" ? root : arg === "OUT" ? OUT() : arg));

    expect(() => runSlices(args)).toThrow(InputError);
    expect(() => runSlices(args)).toThrow(message);
    expect(readFileSync(OUT(), "utf8")).toBe(COMMITTED);
  });

  it("rejects a --config that does not exist", () => {
    expect(() => runSlices(["--root", root, "--config", join(root, "nope.json")])).toThrow(
      new InputError(`--config ${join(root, "nope.json")} cannot be read`),
    );
    expect(readFileSync(OUT(), "utf8")).toBe(COMMITTED);
  });

  it("rejects a --config that is not JSON", () => {
    write("slices.config.json", "{ tables: [");

    expect(() => runSlices(["--root", root, "--config", CONFIG()])).toThrow(InputError);
    expect(() => runSlices(["--root", root, "--config", CONFIG()])).toThrow(`${CONFIG()} is not JSON`);
    expect(readFileSync(OUT(), "utf8")).toBe(COMMITTED);
  });

  it("rejects a --root that does not exist", () => {
    const missing = join(root, "nowhere");

    expect(() => runSlices(["--root", missing])).toThrow(new InputError(`--root ${missing} does not exist`));
  });

  it("rejects a --tsconfig that does not exist", () => {
    const missing = join(root, "tsconfig.nope.json");

    expect(() => runSlices(["--root", root, "--tsconfig", missing])).toThrow(InputError);
    expect(() => runSlices(["--root", root, "--tsconfig", missing])).toThrow(`${missing} does not exist`);
    expect(readFileSync(OUT(), "utf8")).toBe(COMMITTED);
  });

  it("rejects an --app directory that does not exist", () => {
    expect(() => runSlices(["--root", root, "--app", "pages"])).toThrow(InputError);
    expect(() => runSlices(["--root", root, "--app", "pages"])).toThrow(`app directory ${join(root, "pages")} does not exist`);
    expect(readFileSync(OUT(), "utf8")).toBe(COMMITTED);
  });
});
