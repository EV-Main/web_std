/**
 * `evinvest-i18n-rekey` — the one-off move off 0.13's keyed strings.
 *
 * Rewrites every `t("key", "English", values?)` to `t("English", values?)`, and
 * each `messages/<locale>/common.json` (`{ key: { en, t } }`) to
 * `messages/<locale>.json` (`{ English: t }`) beside an empty generated
 * `<locale>.auto.json`. The source locale's directory, a build artefact, goes.
 *
 * Nothing is written unless every call site and catalogue reads cleanly.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { defaultLocaleRegistry } from "../index.js";
import {
  DEFAULT_EXCLUDE,
  InputError,
  list,
  literal,
  parse,
  parseFlags,
  serialise,
  sourceFiles,
  where,
} from "./calls.js";
import { autoPath, overridesPath, serialiseAuto } from "./index.js";

const USAGE = `Usage: evinvest-i18n-rekey [--root <dir>] [--messages <dir>] [--exclude <a,b>]

Move an app off @evinvest/i18n 0.13's keys: t("key", "English", …) becomes
t("English", …), and messages/<locale>/common.json becomes messages/<locale>.json
keyed by English. Run once, on a clean tree; review the diff.

  --root <dir>       the app to rewrite (default: the working directory)
  --messages <dir>   where the catalogues live (default: <root>/messages)
  --exclude <a,b>    directory and file names that are not source, at any depth
  -h, --help         print this and exit`;

interface Edit {
  start: number;
  end: number;
}

function readOld(path: string): Record<string, { en: string; t: string }> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new InputError(`${path}: not a JSON object`);
  const bad = Object.entries(raw).filter(
    ([, v]) =>
      typeof v !== "object" ||
      v === null ||
      Object.keys(v).sort().join() !== "en,t" ||
      typeof (v as Record<string, unknown>)["en"] !== "string" ||
      typeof (v as Record<string, unknown>)["t"] !== "string",
  );
  if (bad.length > 0)
    throw new InputError(`${path}: not { en, t }: ${bad.map(([key]) => JSON.stringify(key)).join(", ")}`);
  return raw as Record<string, { en: string; t: string }>;
}

export function runRekey(argv: readonly string[]): void {
  const flags = parseFlags(argv, ["root", "messages", "exclude"]);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const root = flags.value("root") ?? process.cwd();
  if (!existsSync(root)) throw new InputError(`--root ${root} does not exist`);
  const messages = flags.value("messages") ?? join(root, "messages");
  const { defaultLocale, locales } = defaultLocaleRegistry;
  if (!existsSync(join(messages, defaultLocale, "common.json")))
    throw new InputError(`${join(messages, defaultLocale, "common.json")} does not exist — not a 0.13 layout`);

  const skip = new Set([...DEFAULT_EXCLUDE, ...list(flags.value("exclude"))]);
  const english = new Map<string, { en: string; at: string }>();
  const rewrites = new Map<string, { text: string; edits: Edit[] }>();
  const errors: string[] = [];
  for (const path of sourceFiles(root, skip, "")) {
    const text = readFileSync(join(root, path), "utf8");
    const source = parse(path, text);
    const edits: Edit[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        const [keyArg, enArg] = node.arguments;
        const key = keyArg === undefined ? null : literal(keyArg);
        const en = enArg === undefined ? null : literal(enArg);
        const at = where(path, source, node);
        if (keyArg === undefined || enArg === undefined || key === null || en === null)
          errors.push(`${at}: not t("key", "English", …)`);
        else {
          const known = english.get(key);
          if (known !== undefined && known.en !== en)
            errors.push(`${at}: "${key}" is ${JSON.stringify(en)} here, ${JSON.stringify(known.en)} at ${known.at}`);
          english.set(key, known ?? { en, at });
          edits.push({ start: keyArg.getStart(source), end: enArg.getStart(source) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (edits.length > 0) rewrites.set(path, { text, edits });
  }

  const report: string[] = [];
  const byFirst = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : 1);
  const catalogues = new Map<string, Map<string, { t: string; key: string }>>();
  for (const dir of readdirSync(messages, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const locale = dir.name;
    if (!(locales as readonly string[]).includes(locale)) {
      errors.push(`${join(messages, locale)}: not a locale`);
      continue;
    }
    const files = readdirSync(join(messages, locale));
    if (files.join() !== "common.json") errors.push(`${join(messages, locale)}: holds more than common.json`);
    if (locale === defaultLocale) continue;
    for (const path of [overridesPath(messages, locale), autoPath(messages, locale)])
      if (existsSync(path)) errors.push(`${path} already exists`);
    const translated = new Map<string, { t: string; key: string }>();
    for (const [key, { en, t }] of Object.entries(readOld(join(messages, locale, "common.json"))).sort(byFirst)) {
      const current = english.get(key)?.en;
      const kept = current === undefined ? undefined : translated.get(current);
      if (current === undefined) report.push(`${locale} "${key}": dropped — no t() renders it`);
      else if (current !== en)
        report.push(`${locale} "${key}": dropped — translated ${JSON.stringify(en)}, the code says ${JSON.stringify(current)}`);
      else if (kept === undefined) translated.set(current, { t, key });
      else if (kept.t !== t)
        report.push(
          `${locale} ${JSON.stringify(current)}: "${kept.key}" → ${JSON.stringify(kept.t)} kept, ` +
            `"${key}" → ${JSON.stringify(t)} dropped — give one a t.ctx by hand`,
        );
    }
    catalogues.set(locale, translated);
  }
  if (errors.length > 0) throw new InputError(`nothing written:\n  ${errors.join("\n  ")}`);

  for (const [path, { text, edits }] of rewrites) {
    let out = text;
    for (const { start, end } of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, start) + out.slice(end);
    writeFileSync(join(root, path), out);
  }
  for (const [locale, translated] of catalogues) {
    const overrides = [...translated].sort(byFirst).map(([en, { t }]) => [en, t]);
    writeFileSync(overridesPath(messages, locale), serialise(Object.fromEntries(overrides)));
    writeFileSync(autoPath(messages, locale), serialiseAuto(locale, {}));
    rmSync(join(messages, locale), { recursive: true });
  }
  rmSync(join(messages, defaultLocale), { recursive: true });

  const calls = [...rewrites.values()].reduce((n, { edits }) => n + edits.length, 0);
  console.log(`${calls} t() calls rewritten in ${rewrites.size} files`);
  for (const [locale, translated] of catalogues)
    console.log(`${locale}: ${translated.size} translations → ${overridesPath(messages, locale)}`);
  for (const line of report) console.log(line);
}
