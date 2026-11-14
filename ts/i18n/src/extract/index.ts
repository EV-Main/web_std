/**
 * @module @evinvest/i18n/extract
 *
 * Reads every `t(en)` / `t.ctx(ctx, en)` out of a source tree: the ids every
 * locale must translate. No English catalogue is written — the code is the only
 * place English lives.
 *
 * Per non-default locale, `messages/` holds `<locale>.auto.json` (generated) and
 * `<locale>.json` (hand-written overrides), both keyed by message id.
 *
 * Syntactic only — `ts.createSourceFile`, no program, no type checker. Every
 * `t` in an app is the same `t`, so a name match is enough. `typescript` is an
 * optional peer dependency: it is needed to run the extractor, never to render a
 * string.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultLocaleRegistry, type LocaleRegistry, type Messages } from "../index.js";
import { auditCatalogues, createPolicy, type ResolvedCatalogue } from "../policy/index.js";
import { english } from "../registry.js";
import {
  callsIn,
  DEFAULT_EXCLUDE,
  dedupe,
  InputError,
  list,
  parse,
  parseFlags,
  serialise,
  sourceFiles,
  type Entry,
  type Extraction,
} from "./calls.js";

export { DEFAULT_EXCLUDE, InputError, runCli } from "./calls.js";
export type { Entry, Extraction } from "./calls.js";
export {
  messageSlices,
  runSlices,
  serialiseSlices,
  SLICES_HEADER,
  type SliceOptions,
  type SliceResult,
  type TableRule,
} from "./slices.js";
export { runRekey } from "./rekey.js";

/** Where to look, and what not to look at. */
export interface ExtractOptions {
  /** Directory to scan, recursively. */
  root: string;
  /**
   * Directory and file names to skip, at any depth.
   *
   * What is NOT source, rather than what is. A list of source *directories* is
   * a hole that opens the day someone adds a slice, and an unscanned call site
   * produces no error — just English forever in every locale. Dot-prefixed
   * names are always skipped; {@link DEFAULT_EXCLUDE} covers what every app has.
   */
  exclude?: readonly string[];
}

/**
 * Every `t()` under `root`, one entry per id, plus the call sites that cannot be
 * read. A call that cannot be read statically is an error, not a skip: copy
 * assembled at runtime has no English to translate.
 */
export function collect({ root, exclude = DEFAULT_EXCLUDE }: ExtractOptions): Extraction {
  const skip = new Set([...DEFAULT_EXCLUDE, ...exclude]);
  const entries: Entry[] = [];
  const errors: string[] = [];

  for (const path of sourceFiles(root, skip, "")) {
    const found = callsIn(path, parse(path, readFileSync(join(root, path), "utf8")));
    entries.push(...found.entries);
    errors.push(...found.errors);
  }
  return { entries: dedupe(entries), errors };
}

export { serialise } from "./calls.js";

/** The first key of a generated catalogue: a note to whoever opens it, not a message. */
const HEADER = "//";

/** `<messages>/<locale>.json` — the hand-written overrides. */
export const overridesPath = (messages: string, locale: string): string => join(messages, `${locale}.json`);

/** `<messages>/<locale>.auto.json` — the generated catalogue. */
export const autoPath = (messages: string, locale: string): string => join(messages, `${locale}.auto.json`);

/** A generated catalogue's exact bytes: its header, then one entry per line in byte order. */
export function serialiseAuto(locale: string, messages: Messages): string {
  const sorted = Object.keys(messages)
    .sort()
    .map(id => [id, messages[id]] as const);
  return serialise(
    Object.fromEntries([[HEADER, `GENERATED — overrides go in ${locale}.json`], ...sorted]),
  );
}

function readCatalogue(path: string): Record<string, string> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new InputError(`${path}: not a JSON object`);
  const bad = Object.entries(raw).filter(([, t]) => typeof t !== "string");
  if (bad.length > 0) throw new InputError(`${path}: not a string: ${bad.map(([id]) => JSON.stringify(id)).join(", ")}`);
  return raw as Record<string, string>;
}

/** One locale's two catalogues, as on disk. */
export interface LocaleCatalogues {
  auto: Record<string, string>;
  overrides: Record<string, string>;
}

/** Read `locale`'s generated catalogue (header dropped) and overrides. */
export function readLocale(messages: string, locale: string): LocaleCatalogues {
  const { [HEADER]: header, ...auto } = readCatalogue(autoPath(messages, locale));
  if (header === undefined) throw new InputError(`${autoPath(messages, locale)}: no "${HEADER}" header — not a generated catalogue`);
  return { auto, overrides: readCatalogue(overridesPath(messages, locale)) };
}

/**
 * The slice of a locale registry the extractor reads: which locales exist, and
 * which one is the source. Every function here defaults it to the generated
 * registry.
 */
export type CatalogueLocales<L extends string = string> = Pick<LocaleRegistry<L>, "locales" | "defaultLocale">;

/** The non-default locales with catalogues on disk; a locale with one of its two files and not the other is refused. */
export function translatedLocales<L extends string>(
  messages: string,
  registry: CatalogueLocales<L>,
): L[] {
  return registry.locales.filter(locale => {
    if (locale === registry.defaultLocale) return false;
    const auto = existsSync(autoPath(messages, locale));
    const overrides = existsSync(overridesPath(messages, locale));
    if (auto !== overrides)
      throw new InputError(
        `${locale}: ${auto ? autoPath(messages, locale) : overridesPath(messages, locale)} exists without ` +
          `${auto ? overridesPath(messages, locale) : autoPath(messages, locale)} — create it as {}`,
      );
    return auto;
  });
}

const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length] ?? 0;
};

/** The call site an orphaned override most likely meant: the closest English, relative to its length, with no override of its own. */
function nearest(orphan: string, entries: readonly Entry[], overrides: Messages): Entry | undefined {
  let best: { entry: Entry; d: number } | undefined;
  for (const entry of entries) {
    if (Object.hasOwn(overrides, entry.id)) continue;
    const d = distance(english(orphan), entry.en) / Math.max(english(orphan).length, entry.en.length);
    if (best === undefined || d < best.d) best = { entry, d };
  }
  return best?.entry;
}

const renamed = (orphan: string, entries: readonly Entry[], overrides: Messages): string => {
  const to = nearest(orphan, entries, overrides);
  return to === undefined ? "" : `\n         nearest now: ${JSON.stringify(to.id)} (${to.where})`;
};

/**
 * Prune every locale's catalogues to the ids the code renders.
 *
 * @returns A line per locale, and per dropped override, for the caller to print.
 */
export function pruneCatalogues(
  messages: string,
  entries: readonly Entry[],
  registry: CatalogueLocales = defaultLocaleRegistry,
): string[] {
  const rendered = new Set(entries.map(e => e.id));
  const keep = (catalogue: Messages) => Object.fromEntries(Object.entries(catalogue).filter(([id]) => rendered.has(id)));
  const lines = [`${registry.defaultLocale}: ${rendered.size} strings in the code`];

  for (const locale of translatedLocales(messages, registry)) {
    const { auto, overrides } = readLocale(messages, locale);
    const keptAuto = keep(auto);
    const keptOverrides = keep(overrides);
    writeFileSync(autoPath(messages, locale), serialiseAuto(locale, keptAuto));
    writeFileSync(overridesPath(messages, locale), serialise(keptOverrides));
    const dropped = Object.keys(auto).length - Object.keys(keptAuto).length;
    lines.push(`${locale}: ${dropped} generated dropped`);
    for (const id of Object.keys(overrides).filter(id => !rendered.has(id)))
      lines.push(`${locale}: override dropped: ${JSON.stringify(id)} → ${JSON.stringify(overrides[id])}${renamed(id, entries, keptOverrides)}`);
  }
  return lines;
}

// ── The bins ─────────────────────────────────────────────────────────────────
//
// `cli/*.mjs` are three-line launchers around these. The argument shapes are
// identical, so a check and the extract that fixes it can never be pointed at
// different trees.

const usage = (bin: string, does: string) =>
  `Usage: ${bin} [--root <dir>] [--messages <dir>] [--exclude <a,b>]

${does}

  --root <dir>       the app to scan (default: the working directory)
  --messages <dir>   where the catalogues live (default: <root>/messages)
  --exclude <a,b>    directory and file names that are not source, at any depth
  -h, --help         print this and exit`;

function read(argv: readonly string[], help: string): { messages: string; entries: Entry[] } | null {
  const flags = parseFlags(argv, ["root", "messages", "exclude"]);
  if (flags.help) {
    console.log(help);
    return null;
  }
  const root = flags.value("root") ?? process.cwd();
  const messages = flags.value("messages") ?? join(root, "messages");
  if (!existsSync(root)) throw new InputError(`--root ${root} does not exist`);
  const { entries, errors } = collect({ root, exclude: list(flags.value("exclude")) });
  if (errors.length === 0) return { messages, entries };

  console.error(`${errors.length} t() call site${errors.length === 1 ? "" : "s"} the extractor cannot read:\n`);
  for (const error of errors) console.error(`  ${error}`);
  console.error(
    "\nEvery t() takes literal English (t.ctx: a literal context, then literal English)." +
      " Copy picked by data goes in a closed table: { draft: t => t(\"Draft\"), … }.",
  );
  process.exit(1);
}

/**
 * `evinvest-i18n-extract` — prune every locale's generated catalogue and
 * overrides to the ids the code renders.
 *
 * @param registry - Whose locales to prune. The bin uses the generated registry;
 *   a surface with its own set calls this from a launcher of its own.
 */
export function runExtract(argv: readonly string[], registry: CatalogueLocales = defaultLocaleRegistry): void {
  const found = read(
    argv,
    usage("evinvest-i18n-extract", "Prune every locale's generated catalogue and overrides to the strings the code renders."),
  );
  if (found === null) return;
  for (const line of pruneCatalogues(found.messages, found.entries, registry)) console.log(line);
}

/**
 * `evinvest-i18n-check` — the build gate. Fatal: a call site the extractor cannot
 * read, a string with no accepted translation in some locale, an override or a
 * generated entry for English the code no longer renders (the override's nearest
 * new string named), a structural mismatch.
 *
 * @param registry - Whose locales to check; see {@link runExtract}.
 */
export function runCheck(argv: readonly string[], registry: CatalogueLocales = defaultLocaleRegistry): void {
  const found = read(
    argv,
    usage(
      "evinvest-i18n-check",
      "Fail unless every string the code renders has an accepted translation in every\nlocale, and no catalogue holds one for English the code no longer renders.",
    ),
  );
  if (found === null) return;
  const { messages, entries } = found;
  const { resolveCatalogue } = createPolicy(registry);
  const ids = entries.map(e => e.id);
  const where = new Map(entries.map(e => [e.id, e.where]));

  const resolved: ResolvedCatalogue<string>[] = [];
  const problems: string[] = [];
  for (const locale of translatedLocales(messages, registry)) {
    const { auto, overrides } = readLocale(messages, locale);
    const r = resolveCatalogue(locale, ids, auto, overrides);
    resolved.push(r);
    for (const { key, reason, detail } of r.rejected)
      problems.push(
        `${locale} ${JSON.stringify(key)}: ${reason} — ${detail}` +
          (reason === "orphan-override" ? renamed(key, entries, overrides) : ` (${where.get(key) ?? autoPath(messages, locale)})`),
      );
    for (const id of r.missing) problems.push(`${locale} ${JSON.stringify(id)}: untranslated (${where.get(id)})`);
  }
  console.log(auditCatalogues(resolved, 1).report);
  if (problems.length === 0) return;

  console.error(`\n${problems.length} i18n problem${problems.length === 1 ? "" : "s"}:`);
  for (const line of problems) console.error(`  ${line}`);
  console.error(
    "\nAn orphaned override: re-key it to the new English in <locale>.json, or delete it to take the generated one." +
      "\nA refused or missing generated entry: delete it, then generate.",
  );
  process.exit(1);
}
