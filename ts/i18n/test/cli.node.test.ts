import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseFlags } from "../src/extract/calls";
import { InputError, runCheck, runCli, runExtract, serialiseAuto } from "../src/extract/index";

afterEach(() => {
  vi.restoreAllMocks();
});

const VALUES = ["root", "out"] as const;
const SWITCHES = ["check"] as const;
const parse = (...argv: string[]) => parseFlags(argv, VALUES, SWITCHES);

describe("parseFlags", () => {
  it("reads a value given as --name value", () => {
    expect(parse("--root", "app").value("root")).toBe("app");
  });

  it("reads a value given as --name=value", () => {
    expect(parse("--root=app").value("root")).toBe("app");
  });

  it("keeps everything after the first = as the value", () => {
    expect(parse("--root=a=b").value("root")).toBe("a=b");
  });

  it("leaves an absent flag undefined and an absent switch off", () => {
    const flags = parse();

    expect(flags.value("root")).toBeUndefined();
    expect(flags.on("check")).toBe(false);
    expect(flags.help).toBe(false);
  });

  it("turns a switch on when present", () => {
    expect(parse("--check").on("check")).toBe(true);
  });

  it.each([["--help"], ["-h"]])("sets help for %s, alongside other flags", flag => {
    const flags = parse("--root", "app", flag, "--check");

    expect(flags.help).toBe(true);
    expect(flags.value("root")).toBe("app");
  });

  it("names every known flag when it meets an unknown one", () => {
    expect(() => parse("--bogus")).toThrow(InputError);
    expect(() => parse("--bogus")).toThrow(
      new InputError("unknown flag --bogus; known: --root <value>, --out <value>, --check, --help"),
    );
  });

  it("rejects an unknown flag even when help is asked for", () => {
    expect(() => parse("--help", "--bogus")).toThrow("unknown flag --bogus");
  });

  it("rejects a value flag given last with no value", () => {
    expect(() => parse("--check", "--root")).toThrow(new InputError("--root needs a value"));
  });

  it("rejects a value flag followed by another flag", () => {
    expect(() => parse("--out", "--check")).toThrow(new InputError("--out needs a value"));
  });

  it("rejects an empty --name=", () => {
    expect(() => parse("--root=")).toThrow(new InputError("--root needs a value"));
  });

  it("rejects a value flag given twice", () => {
    expect(() => parse("--root", "a", "--root=b")).toThrow(new InputError("--root given more than once"));
  });

  it("rejects a switch given twice", () => {
    expect(() => parse("--check", "--check")).toThrow(new InputError("--check given more than once"));
  });

  it("rejects a positional argument", () => {
    expect(() => parse("--root", "app", "stray")).toThrow(new InputError('unexpected argument "stray"'));
  });

  it("rejects a single-dash flag other than -h", () => {
    expect(() => parse("-r")).toThrow(new InputError('unexpected argument "-r"'));
  });

  it("rejects a value on a switch", () => {
    expect(() => parse("--check=yes")).toThrow(new InputError("--check takes no value"));
  });
});

describe("runCli", () => {
  /** `process.exit` as a throw, so the test sees where the bin would stop. */
  const exits = () =>
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    });

  it("prints an InputError as `<bin>: <message>` with a hint, no stack, and exits 2", () => {
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      runCli("evinvest-i18n-slices", () => {
        throw new InputError("--root needs a value");
      }),
    ).toThrow("exit 2");

    expect(exit).toHaveBeenCalledWith(2);
    expect(error.mock.calls).toEqual([
      ["evinvest-i18n-slices: --root needs a value"],
      ["Run `evinvest-i18n-slices --help` for usage."],
    ]);
  });

  it("treats a file the arguments name that does not exist as input, exit 2", () => {
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      runCli("evinvest-i18n-check", () => {
        readFileSync(join(tmpdir(), "i18n-cli-does-not-exist", "common.json"), "utf8");
      }),
    ).toThrow("exit 2");

    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^evinvest-i18n-check: ENOENT/));
  });

  it("lets any other Error through with its stack", () => {
    const exit = exits();
    const bug = new TypeError("a bug");

    expect(() =>
      runCli("evinvest-i18n-extract", () => {
        throw bug;
      }),
    ).toThrow(bug);
    expect(exit).not.toHaveBeenCalled();
  });

  it("lets a thrown non-Error through untouched", () => {
    const exit = exits();

    expect(() =>
      runCli("evinvest-i18n-extract", () => {
        throw "not an error";
      }),
    ).toThrow("not an error");
    expect(exit).not.toHaveBeenCalled();
  });

  it("returns without exiting when the body succeeds", () => {
    const exit = exits();
    const main = vi.fn();

    runCli("evinvest-i18n-extract", main);

    expect(main).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("runExtract and runCheck", () => {
  let root: string;
  const AUTO = serialiseAuto("ru", { "From the code": "Из кода", "Menu": "Меню", "Gone": "Ушло" });
  const RU = '{\n  "From": "Из кода, вручную"\n}\n';
  const auto = () => readFileSync(join(root, "messages", "ru.auto.json"), "utf8");
  const ru = () => readFileSync(join(root, "messages", "ru.json"), "utf8");

  /** `process.exit(1)` as a throw; stderr collected. */
  const run = (argv: string[]) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    });
    let outcome = "ok";
    try {
      runCheck(argv);
    } catch (e) {
      outcome = (e as Error).message;
    }
    return { outcome, stderr: error.mock.calls.map(c => c.join(" ")).join("\n") };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i18n-cli-"));
    writeFileSync(join(root, "page.tsx"), 'export const P = () => [t("From the code"), t("Menu")];\n');
    mkdirSync(join(root, "messages"));
    writeFileSync(join(root, "messages", "ru.auto.json"), AUTO);
    writeFileSync(join(root, "messages", "ru.json"), RU);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extract prints the usage for --help and leaves the catalogues alone", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    runExtract(["--root", root, "--help"]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Usage: evinvest-i18n-extract/));
    expect(auto()).toBe(AUTO);
    expect(ru()).toBe(RU);
  });

  it("check prints the usage for -h without checking", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    runCheck(["--root", root, "-h"]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Usage: evinvest-i18n-check/));
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown flag", ["--root", "ROOT", "--bogus"], "unknown flag --bogus"],
    ["--messages without a value", ["--root", "ROOT", "--messages"], "--messages needs a value"],
    ["a repeated --root", ["--root", "ROOT", "--root", "ROOT"], "--root given more than once"],
  ])("extract rejects %s and leaves the catalogues alone", (_, argv, message) => {
    // `it.each` rows are built before `root` exists, so they name it by placeholder.
    const args = argv.map(arg => (arg === "ROOT" ? root : arg));

    expect(() => runExtract(args)).toThrow(InputError);
    expect(() => runExtract(args)).toThrow(message);
    expect(auto()).toBe(AUTO);
    expect(ru()).toBe(RU);
  });

  it("rejects a --root that does not exist", () => {
    const missing = join(root, "nowhere");

    expect(() => runExtract(["--root", missing])).toThrow(new InputError(`--root ${missing} does not exist`));
  });

  it("refuses a locale with one of its two catalogues", () => {
    rmSync(join(root, "messages", "ru.json"));

    expect(() => runCheck(["--root", root])).toThrow(/ru\.auto\.json exists without .*ru\.json/);
  });

  it("extract prunes both catalogues to the code", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    runExtract([`--root=${root}`]);

    expect(auto()).toBe(serialiseAuto("ru", { "From the code": "Из кода", "Menu": "Меню" }));
    expect(ru()).toBe("{}\n");
  });

  it("check fails on an orphaned override, naming the string it most likely meant", () => {
    const { outcome, stderr } = run(["--root", root]);

    expect(outcome).toBe("exit 1");
    expect(stderr).toMatch(/ru "From": orphan-override .*\n\s+nearest now: "From the code" \(page\.tsx:1\)/);
    expect(stderr).toMatch(/ru "Gone": orphan-auto/);
  });

  it("check fails on English the code renders with no translation", () => {
    writeFileSync(join(root, "messages", "ru.json"), "{}");
    writeFileSync(join(root, "page.tsx"), 'export const P = () => [t("From the code"), t.ctx("tab", "From the code")];\n');
    writeFileSync(join(root, "messages", "ru.auto.json"), serialiseAuto("ru", { "From the code": "Из кода", "Menu": "Меню" }));

    const { outcome, stderr } = run(["--root", root]);

    expect(outcome).toBe("exit 1");
    expect(stderr).toMatch(/ru "tab\\u0004From the code": untranslated \(page\.tsx:1\)/);
  });

  it("check fails on a structural mismatch and passes once re-keyed and fixed", () => {
    writeFileSync(join(root, "page.tsx"), 'export const P = () => t("Hi, {name}", { name });\n');
    writeFileSync(join(root, "messages", "ru.auto.json"), serialiseAuto("ru", { "Hi, {name}": "Привет" }));
    writeFileSync(join(root, "messages", "ru.json"), "{}");

    expect(run(["--root", root]).stderr).toMatch(/placeholder-mismatch — generated: source interpolates \{name\}/);

    writeFileSync(join(root, "messages", "ru.json"), JSON.stringify({ "Hi, {name}": "Привет, {name}" }));
    expect(run(["--root", root]).outcome).toBe("ok");
  });

  it("refuses the old t(key, en) shape", () => {
    writeFileSync(join(root, "page.tsx"), 'export const P = () => t("hero.title", "From the code");\n');

    expect(run(["--root", root]).stderr).toMatch(/a key is no longer written/);
  });
});
