/**
 * @module @evinvest/i18n/extract
 *
 * Reads every `t(key, en)` out of a source tree and writes the English
 * catalogue back out of it.
 *
 * English is authored where it is rendered — `t(hero.title, "We build …")`,
 * `hero = scope("hero")` — so `messages/en/common.json` is a build artefact. Each
 * other locale is `messages/<locale>/common.auto.json` (generated) under
 * `messages/<locale>/common.json` (hand overrides), both `{ key: {en, t} }`.
 *
 * Syntactic only — `ts.createSourceFile`, no program, no type checker. A key is
 * followed through `const` bindings and imports back to its `scope("<literal>")`
 * (see `createKeys`). `typescript` is an optional peer dependency: it is needed
 * to run the extractor, never to render a string.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  defaultLocaleRegistry,
  type Locale,
  type LocaleRegistry,
  type Messages,
} from "../index.js";
import {
  auditCatalogues,
  createPolicy,
  type TranslatedCatalogue,
  type TranslatedEntry,
} from "../policy/index.js";
import { createResolver, readPaths } from "./resolve.js";
import {
  callsIn,
  createKeys,
  DEFAULT_EXCLUDE,
  dedupe,
  InputError,
  list,
  parseFlags,
  serialise,
  sourceFiles,
  type Entry,
  type Extraction,
} from "./calls.js";

export { DEFAULT_EXCLUDE, InputError, runCli } from "./calls.js";
export { rekey, runRekey } from "./rekey.js";
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

/** Where to look, and what not to look at. */
export interface ExtractOptions {
  /** Directory to scan, recursively. */
  root: string;
  /**
   * Directory and file names to skip, at any depth.
   *
   * What is NOT source, rather than what is. A list of source *directories* is
   * a hole that opens the day someone adds a slice, and an unscanned call site
   * produces no error — just English forever in five locales. Dot-prefixed
   * names are always skipped; {@link DEFAULT_EXCLUDE} covers what every app has.
   */
  exclude?: readonly string[];
  /** The tsconfig whose `paths` and `baseUrl` resolve imports. Defaults to `<root>/tsconfig.json` when present. */
  tsconfig?: string;
}

/**
 * Every `t(key, en)` under `root`, plus the call sites that cannot be read.
 *
 * A call that cannot be read statically is an error, not a skip: a key that does
 * not resolve to a member chain off a `scope("<literal>")` has no place in a
 * catalogue. Two call sites sharing a key with
 * different English is the same class of error — the catalogue can only hold
 * one of them, so which one ships would be decided by file order.
 */
export function collect({ root, exclude = DEFAULT_EXCLUDE, tsconfig }: ExtractOptions): Extraction {
  const skip = new Set([...DEFAULT_EXCLUDE, ...exclude]);
  const config = tsconfig ?? join(root, "tsconfig.json");
  if (tsconfig !== undefined && !existsSync(config)) throw new InputError(`${config} does not exist`);
  const keys = createKeys(root, createResolver(root, existsSync(config) ? readPaths(config) : null));
  const entries: Entry[] = [];
  const errors: string[] = [];

  for (const path of sourceFiles(root, skip, "")) {
    const found = callsIn(path, keys);
    entries.push(...found.entries);
    errors.push(...found.errors);
  }

  const unique = dedupe(entries);
  return { entries: unique.entries, errors: [...errors, ...unique.errors] };
}

/** Sorted, so the generated file diffs by key rather than by call-site order. */
export function catalogue(entries: readonly Entry[]): Record<string, string> {
  return Object.fromEntries(
    entries.map(e => [e.key, e.en] as const).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

export { serialise } from "./calls.js";

/** `<messages>/<locale>/common.json`: English for the source locale, hand overrides for the rest. */
export const cataloguePath = (messages: string, locale: string): string =>
  join(messages, locale, "common.json");

/** `<messages>/<locale>/common.auto.json`: a non-source locale's generated layer. */
export const autoCataloguePath = (messages: string, locale: string): string =>
  join(messages, locale, "common.auto.json");

/**
 * The slice of a locale registry the extractor reads: which catalogues exist,
 * and which one is the source. Every function here defaults it to the generated
 * registry; pass your own `createLocaleRegistry` result to extract for another
 * locale set.
 */
export type CatalogueLocales<L extends string = string> = Pick<
  LocaleRegistry<L>,
  "locales" | "defaultLocale"
>;

/** The non-default locales that have a directory under `messages`. */
export function translatedLocales(messages: string): Locale[];
export function translatedLocales<L extends string>(
  messages: string,
  registry: CatalogueLocales<L>,
): L[];
export function translatedLocales(
  messages: string,
  registry: CatalogueLocales = defaultLocaleRegistry,
): string[] {
  const present = new Set(
    readdirSync(messages, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name),
  );
  return registry.locales.filter(l => l !== registry.defaultLocale && present.has(l));
}

/** One layer of a locale, every entry checked to be `{en, t}`: it is written by hand. */
export function readLayer(path: string): TranslatedCatalogue {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new InputError(`${path}: expected an object of { "key": { "en", "t" } }`);
  for (const [key, entry] of Object.entries(raw)) {
    const shaped =
      typeof entry === "object" && entry !== null && Object.keys(entry).sort().join() === "en,t" &&
      typeof (entry as TranslatedEntry).en === "string" && typeof (entry as TranslatedEntry).t === "string";
    if (!shaped) throw new InputError(`${path}: "${key}" is not { "en": string, "t": string }`);
  }
  return raw as TranslatedCatalogue;
}

/**
 * One layer cut to what is still a translation of today's English. An orphan moves to a new
 * key only when its recorded `en` is the English of exactly one key this layer lacks, and no
 * other orphan claims that key — what a renamed scope leaves. A stale entry is dropped. Every
 * move and drop is a line.
 */
function reconcile(
  en: Messages,
  layer: TranslatedCatalogue,
  label: string,
): { kept: Record<string, TranslatedEntry>; lines: string[] } {
  const kept: Record<string, TranslatedEntry> = {};
  const orphans: [string, TranslatedEntry][] = [];
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(layer)) {
    if (!Object.hasOwn(en, key)) orphans.push([key, entry]);
    else if (entry.en === en[key]) kept[key] = entry;
    else lines.push(`  ${label}: dropped stale ${key} (${JSON.stringify(entry.en)})`);
  }
  const lacking = new Map<string, string[]>();
  for (const [key, text] of Object.entries(en)) {
    if (Object.hasOwn(kept, key)) continue;
    lacking.set(text, [...(lacking.get(text) ?? []), key]);
  }
  const targetOf = (entry: TranslatedEntry) => {
    const candidates = lacking.get(entry.en) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const claims = new Map<string, number>();
  for (const [, entry] of orphans) {
    const target = targetOf(entry);
    if (target !== undefined) claims.set(target, (claims.get(target) ?? 0) + 1);
  }
  for (const [key, entry] of orphans) {
    const target = targetOf(entry);
    if (target !== undefined && claims.get(target) === 1) {
      kept[target] = entry;
      lines.push(`  ${label}: moved ${key} → ${target}`);
    } else {
      lines.push(`  ${label}: dropped ${key} (${JSON.stringify(entry.en)})`);
    }
  }
  const sorted = Object.fromEntries(Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { kept: sorted, lines };
}

/**
 * Write the source catalogue, and reconcile both layers of every other locale with it.
 *
 * @returns A line per catalogue and per moved or dropped entry, for the caller to print.
 */
export function writeCatalogues(
  messages: string,
  entries: readonly Entry[],
  registry: CatalogueLocales = defaultLocaleRegistry,
): string[] {
  const en = catalogue(entries);
  writeFileSync(cataloguePath(messages, registry.defaultLocale), serialise(en));
  const lines = [
    `${registry.defaultLocale}: ${Object.keys(en).length} keys from ${entries.length} call sites`,
  ];

  for (const locale of translatedLocales(messages, registry)) {
    for (const path of [cataloguePath(messages, locale), autoCataloguePath(messages, locale)]) {
      const label = `${locale}/${path.slice(path.lastIndexOf("/") + 1)}`;
      const { kept, lines: changes } = reconcile(en, readLayer(path), label);
      writeFileSync(path, serialise(kept));
      lines.push(`${label}: ${Object.keys(kept).length} entries`, ...changes);
    }
  }
  return lines;
}

// ── The two bins ─────────────────────────────────────────────────────────────
//
// `cli/*.mjs` are three-line launchers around these. The argument shapes are
// identical, so a check and the extract that fixes it can never be pointed at
// different trees.

const usage = (bin: string, does: string, more = "") =>
  `Usage: ${bin} [--root <dir>] [--messages <dir>] [--exclude <a,b>]

${does}

  --root <dir>       the app to scan (default: the working directory)
  --messages <dir>   where the catalogues live (default: <root>/messages)
  --exclude <a,b>    directory and file names that are not source, at any depth
  --tsconfig <file>  whose paths resolve imports (default: <root>/tsconfig.json when present)
${more}  -h, --help         print this and exit`;

/**
 * `--root x --messages y --exclude a,b`; `--root` defaults to the working
 * directory. `null` when `--help` was asked for and printed.
 */
function parseArgs<S extends string>(
  argv: readonly string[],
  help: string,
  switches: readonly S[],
): (ExtractOptions & { messages: string; on: (name: S) => boolean }) | null {
  const flags = parseFlags(argv, ["root", "messages", "exclude", "tsconfig"], switches);
  if (flags.help) {
    console.log(help);
    return null;
  }
  const root = flags.value("root") ?? process.cwd();
  const tsconfig = flags.value("tsconfig");
  return {
    root,
    messages: flags.value("messages") ?? join(root, "messages"),
    exclude: list(flags.value("exclude")),
    on: flags.on,
    ...(tsconfig === undefined ? {} : { tsconfig }),
  };
}

function read<S extends string = never>(
  argv: readonly string[],
  help: string,
  switches: readonly S[] = [],
): { messages: string; entries: Entry[]; on: (name: S) => boolean } | null {
  const args = parseArgs(argv, help, switches);
  if (args === null) return null;
  const { messages, on, ...options } = args;
  if (!existsSync(options.root)) throw new InputError(`--root ${options.root} does not exist`);
  const { entries, errors } = collect(options);
  if (errors.length === 0) return { messages, entries, on };

  console.error(`${errors.length} t() call site${errors.length === 1 ? "" : "s"} the extractor cannot read:\n`);
  for (const error of errors) console.error(`  ${error}`);
  console.error(
    "\nEvery t() takes a key off a scope(\"<literal>\") and a literal English string." +
      " Data-picked copy is a closed table: { draft: t => t(state.draft, \"Draft\"), … }.",
  );
  process.exit(1);
}

/**
 * `evinvest-i18n-extract` — regenerate English from the code, reconcile the rest with it.
 *
 * @param registry - Whose locales to write. The bin uses the generated registry;
 *   a surface with its own set calls this from a launcher of its own.
 */
export function runExtract(
  argv: readonly string[],
  registry: CatalogueLocales = defaultLocaleRegistry,
): void {
  const found = read(
    argv,
    usage(
      "evinvest-i18n-extract",
      "Regenerate the English catalogue from the code's t() calls; move or drop every\nother locale's entries whose keys the code no longer asks for.",
    ),
  );
  if (found === null) return;
  const { messages, entries } = found;
  for (const line of writeCatalogues(messages, entries, registry)) console.log(line);
}

/**
 * `evinvest-i18n-check` — the build gate.
 *
 * Fatal: a committed English catalogue that no longer matches the code, and any
 * refused entry in either layer of a non-source locale (stale, structurally unequal,
 * orphan). With `--release`, any key served in English too: until then a new string
 * renders English and is listed.
 *
 * @param registry - Whose locales to check; see {@link runExtract}.
 */
export function runCheck(
  argv: readonly string[],
  registry: CatalogueLocales = defaultLocaleRegistry,
): void {
  const found = read(
    argv,
    usage(
      "evinvest-i18n-check",
      "Fail when the English catalogue is out of date with the code, or any other\nlocale carries a refused entry; with --release, also when one serves English for a key.",
      "  --release          an untranslated key fails too\n",
    ),
    ["release"],
  );
  if (found === null) return;
  const { messages, entries, on } = found;

  const generated = serialise(catalogue(entries));
  const enPath = cataloguePath(messages, registry.defaultLocale);
  if (generated !== readFileSync(enPath, "utf8")) {
    console.error(`${enPath} is out of date with the code. Run \`evinvest-i18n-extract\`.`);
    process.exit(1);
  }

  const en = JSON.parse(generated) as Messages;
  const { resolveCatalogue } = createPolicy(registry);
  const resolved = translatedLocales(messages, registry).map(locale =>
    resolveCatalogue(
      locale,
      en,
      readLayer(autoCataloguePath(messages, locale)),
      readLayer(cataloguePath(messages, locale)),
    ),
  );
  const { ok, report } = auditCatalogues(resolved, on("release") ? 1 : 0);
  if (!ok) {
    console.error(report);
    console.error(
      "\nA refused override: update its `en` to today's English, or delete it." +
        "\nAn orphan: `evinvest-i18n-extract` moves or drops it." +
        "\nUntranslated: translate it into common.auto.json, or override it in common.json.",
    );
    process.exit(1);
  }
  console.log(report);
}

/** The ask for one root scope's untranslated strings; the answer comes back between the last `<json>` tags. */
function prompt(locale: string, strings: Messages): string {
  const language = new Intl.DisplayNames(["en"], { type: "language" }).of(locale);
  const plural = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.join(", ");
  return (
    `Translate these UI strings of a web app from English to ${language}. Each key is where its string sits in the app. ` +
    `Keep every {placeholder} as it is. Keep ICU syntax ({n, plural, …}, {x, select, …}) with its argument names, ` +
    `and give a plural every category ${language} needs: ${plural}. ` +
    `Reply with one JSON object of the same keys and the translated strings, between <json> and </json>, and nothing else.\n\n` +
    `<json>${JSON.stringify(strings)}</json>`
  );
}

/** `ask_llm`'s answer: it logs to stdout too, its own debug echo of the reply first, so the last tags are the reply. */
function answerOf(stdout: string, asked: Messages): Record<string, string> {
  const open = stdout.lastIndexOf("<json>");
  const close = stdout.lastIndexOf("</json>");
  if (open === -1 || close < open) throw new Error(`ask_llm answered without <json> tags:\n${stdout.slice(-2000)}`);
  const answer: unknown = JSON.parse(stdout.slice(open + "<json>".length, close));
  const keys = (o: object) => Object.keys(o).sort().join("\n");
  if (typeof answer !== "object" || answer === null || keys(answer) !== keys(asked))
    throw new Error(`ask_llm answered other keys than were asked:\n${JSON.stringify(answer)}`);
  for (const [key, value] of Object.entries(answer))
    if (typeof value !== "string") throw new Error(`ask_llm answered ${key} with ${JSON.stringify(value)}`);
  return answer as Record<string, string>;
}

/**
 * `evinvest-i18n-translate` — every key no valid entry translates, asked of `ask_llm -m translate`
 * one root scope at a time and written to `common.auto.json`. An answer the policy refuses
 * (a placeholder lost, a plural short of a category) is printed and not written.
 */
export function runTranslate(
  argv: readonly string[],
  registry: CatalogueLocales = defaultLocaleRegistry,
): void {
  const found = read(
    argv,
    usage(
      "evinvest-i18n-translate",
      "Translate every untranslated key with `ask_llm -m translate`, one root scope at a time,\ninto <messages>/<locale>/common.auto.json.",
    ),
  );
  if (found === null) return;
  const { messages, entries } = found;
  const en = catalogue(entries);
  const { resolveCatalogue } = createPolicy(registry);

  for (const locale of translatedLocales(messages, registry)) {
    const path = autoCataloguePath(messages, locale);
    const auto: Record<string, TranslatedEntry> = { ...readLayer(path) };
    const { missing } = resolveCatalogue(locale, en, auto, readLayer(cataloguePath(messages, locale)));
    const scopes = new Map<string, string[]>();
    for (const key of missing) {
      const root = key.split(".")[0] as string;
      scopes.set(root, [...(scopes.get(root) ?? []), key]);
    }
    for (const [root, keys] of scopes) {
      const asked: Messages = Object.fromEntries(keys.map(key => [key, en[key] as string]));
      const stdout = execFileSync("ask_llm", ["-m", "translate", prompt(locale, asked)], { encoding: "utf8", maxBuffer: 1 << 26 });
      const answer = answerOf(stdout, asked);
      const fresh = Object.fromEntries(keys.map(key => [key, { en: en[key] as string, t: answer[key] as string }]));
      const { rejected } = resolveCatalogue(locale, asked, fresh, {});
      for (const r of rejected) console.error(`${locale}/${r.key}: ${r.reason} — ${r.detail}; not written`);
      const refused = new Set(rejected.map(r => r.key));
      for (const key of keys) if (!refused.has(key)) auto[key] = fresh[key] as TranslatedEntry;
      console.log(`${locale}: ${root} — ${keys.length - refused.size} of ${keys.length} translated`);
    }
    writeFileSync(path, serialise(Object.fromEntries(Object.entries(auto).sort(([a], [b]) => (a < b ? -1 : 1)))));
  }
}
