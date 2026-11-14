/**
 * @module @evinvest/i18n/policy
 *
 * EV's translation policy, enforced in code rather than in review. The Rust half
 * (`ev_lib::i18n::policy`) is canonical; `tests/fixtures/i18n/policy.json` holds both to it.
 *
 * **1.1 — English is canonical.** It lives only at the call sites, and a message's
 * identity is its English ({@link messageId}). Every other locale is a derivation:
 * a generated catalogue (`<locale>.auto.json`) and the hand-written overrides laid
 * over it (`<locale>.json`), both keyed by that identity.
 *
 * **1.2 — A translation that no longer matches its English source is not used.**
 * Because the key *is* the English, an edited sentence leaves its old translation
 * keyed by text nothing renders: an orphan, refused, while the new English is
 * generated afresh.
 *
 * **1.3 — Compiled content with no translation for the current locale is
 * hidden, not silently served in English.** See {@link availableIn}.
 *
 * Nothing here compares *meaning* across languages. What is mechanically checkable
 * is **provenance** (the key) and **structure**: the placeholders, their argument
 * types, and the plural categories a locale requires — a Russian plural with only
 * `one`/`other` is provably wrong.
 */

import { DEFAULT_LOCALE, type Locale, type LocaleRegistry, type Messages } from "../index.js";
import { english } from "../registry.js";
import type { RejectionReason } from "../generated/policy.js";

export type { RejectionReason } from "../generated/policy.js";

const CLDR_ORDER: readonly Intl.LDMLPluralRule[] = ["zero", "one", "two", "few", "many", "other"];

/** One refusal, with enough detail to fix it without opening the catalogue. */
export interface Rejection {
  key: string;
  reason: RejectionReason;
  detail: string;
}

/** The outcome of applying the policy to one locale. */
export interface ResolvedCatalogue<L extends string = Locale> {
  locale: L;
  /** Ready for `translator()`: every accepted translation. */
  messages: Messages;
  rejected: Rejection[];
  /** Ids the code renders that this locale has no accepted translation for. */
  missing: string[];
  /** Share of ids served in this locale, 0–1. */
  coverage: number;
}

/**
 * Apply rules 1.1 and 1.2 to one locale: an override wins over the generated
 * entry, a refused one gives way to it, and an id with neither accepted is missing.
 *
 * @param source    - The id of every string the code renders.
 * @param auto      - The locale's generated catalogue.
 * @param overrides - The locale's hand-written overrides.
 *
 * Bound to the generated registry, whose source is `en`; see {@link createPolicy}.
 */
export function resolveCatalogue(
  locale: Locale,
  source: Iterable<string>,
  auto: Messages,
  overrides: Messages,
): ResolvedCatalogue {
  return resolveAgainst(DEFAULT_LOCALE, locale, source, auto, overrides);
}

/**
 * Rules 1.3 and 1.1/1.2 bound to one registry's source locale. Split out so the
 * source locale is always the registry's own `defaultLocale` — never a default
 * argument that silently reads as `en` for a registry whose source is French.
 */
export interface Policy<L extends string> {
  /** {@link resolveCatalogue} against this registry's source locale. */
  readonly resolveCatalogue: (
    locale: L,
    source: Iterable<string>,
    auto: Messages,
    overrides: Messages,
  ) => ResolvedCatalogue<L>;
  /** {@link availableIn} with this registry's source locale seeing everything. */
  readonly availableIn: <T>(
    locale: L,
    items: readonly T[],
    localesOf: (item: T) => readonly L[] | undefined,
    policy?: MissingContentPolicy,
  ) => T[];
}

/** Bind the policy to a registry built with `createLocaleRegistry`. */
export function createPolicy<L extends string>(
  registry: Pick<LocaleRegistry<L>, "defaultLocale">,
): Policy<L> {
  const canonical = registry.defaultLocale;
  return {
    resolveCatalogue: (locale, source, auto, overrides) =>
      resolveAgainst(canonical, locale, source, auto, overrides),
    availableIn: (locale, items, localesOf, policy = "hide") =>
      availableAgainst(canonical, locale, items, localesOf, policy),
  };
}

function resolveAgainst<L extends string>(
  canonical: string,
  locale: L,
  ids: Iterable<string>,
  auto: Messages,
  overrides: Messages,
): ResolvedCatalogue<L> {
  // Byte order, as Rust's BTreeSet keeps it, so both halves report alike.
  const source = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (locale === canonical) {
    const messages = Object.fromEntries(source.map(id => [id, english(id)]));
    return { locale, messages, rejected: [], missing: [], coverage: 1 };
  }

  const rendered = new Set(source);
  const messages: Record<string, string> = {};
  const rejected: Rejection[] = [];
  const missing: string[] = [];

  for (const [catalogue, reason] of [
    [overrides, "orphan-override"],
    [auto, "orphan-auto"],
  ] as const) {
    for (const key of Object.keys(catalogue).sort()) {
      if (!rendered.has(key)) {
        rejected.push({ key, reason, detail: `the code no longer renders ${JSON.stringify(english(key))}` });
      }
    }
  }

  for (const id of source) {
    const en = english(id);
    let served: string | undefined;
    for (const [catalogue, from] of [
      [overrides, "override"],
      [auto, "generated"],
    ] as const) {
      if (!Object.hasOwn(catalogue, id)) continue;
      const t = catalogue[id] as string;
      const problem = check(t, en, locale, canonical);
      if (problem === null) {
        served = t;
        break;
      }
      rejected.push({ key: id, reason: problem.reason, detail: `${from}: ${problem.detail}` });
    }
    if (served === undefined) missing.push(id);
    else messages[id] = served;
  }

  return {
    locale,
    messages,
    rejected,
    missing,
    coverage: source.length === 0 ? 1 : Object.keys(messages).length / source.length,
  };
}

/** The structural half of rule 1.2 for a single translation. `null` means accepted. */
function check(
  t: string,
  en: string,
  locale: string,
  canonical: string,
): Omit<Rejection, "key"> | null {
  if (t.trim() === "") {
    return { reason: "empty", detail: "translation is blank" };
  }

  const sourceArgs = scanArguments(en);
  const targetArgs = scanArguments(t);

  for (const [name, kind] of sourceArgs) {
    const mirrored = targetArgs.get(name);
    if (mirrored === undefined) {
      return {
        reason: "placeholder-mismatch",
        detail: `source interpolates {${name}}, translation does not`,
      };
    }
    if (mirrored.type !== kind.type) {
      return {
        reason: "argument-type-mismatch",
        detail: `{${name}} is a ${kind.type} in ${canonical} and a ${mirrored.type} here`,
      };
    }
    if (kind.type === "plural") {
      // The arithmetic half of "semantically equal". English has two plural
      // categories; Russian has four. A translation that only mirrors English's
      // branches is missing cases that will be hit by real numbers.
      //
      // `other` is NOT accepted as a wildcard here, even though the formatter
      // falls back to it at runtime. That fallback is what stops a page breaking;
      // it is not evidence the translation is right. A Russian `one`/`other` pair
      // renders "5 участка" for five — grammatical nonsense — and the runtime
      // cannot tell, because it got a branch. The whole point of a build-time
      // check is to catch what degrades silently. A locale that genuinely needs
      // one branch (Vietnamese) declares only `other`, so it passes on the same
      // rule rather than an exemption.
      const required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      const absent = CLDR_ORDER.filter(category => required.includes(category) && !mirrored.branches.has(category)); // Intl's order varies with the ICU version
      if (absent.length > 0) {
        return {
          reason: "plural-category-missing",
          detail: `{${name}} needs ${absent.join(", ")} in ${locale}`,
        };
      }
    }
  }

  for (const name of targetArgs.keys()) {
    if (!sourceArgs.has(name)) {
      return {
        reason: "placeholder-mismatch",
        detail: `translation interpolates {${name}}, which the source does not provide`,
      };
    }
  }

  return null;
}

interface ArgumentShape {
  type: "value" | "plural" | "select";
  branches: Set<string>;
}

/**
 * Extract each argument's name, type, and (for plural/select) branch keys.
 *
 * Deliberately independent of the formatter in `../index.ts`: this needs only
 * the shape of the arguments, never their rendered output, and keeping the two
 * separate means the policy module carries no formatting behaviour it would then
 * have to keep in sync.
 */
function scanArguments(pattern: string): Map<string, ArgumentShape> {
  const found = new Map<string, ArgumentShape>();

  const walk = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      // Mirror the formatter's ICU 4.8 quoting so an escaped '{' is not read as
      // an argument — otherwise "it's '{not}' a placeholder" trips the checker.
      if (ch === "'") {
        const next = text[i + 1];
        if (next === "'") {
          i += 2;
          continue;
        }
        if (next === "{" || next === "}" || next === "#") {
          i += 2;
          while (i < text.length && text[i] !== "'") i += 1;
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }

      if (ch !== "{") {
        i += 1;
        continue;
      }

      const end = closing(text, i);
      if (end === -1) return;
      const inner = text.slice(i + 1, end);
      i = end + 1;

      const firstComma = topLevel(inner, ",");
      if (firstComma === -1) {
        const name = inner.trim();
        if (name !== "" && !found.has(name)) {
          found.set(name, { type: "value", branches: new Set() });
        }
        continue;
      }

      const name = inner.slice(0, firstComma).trim();
      const rest = inner.slice(firstComma + 1);
      const secondComma = topLevel(rest, ",");
      const declared = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim();
      const body = secondComma === -1 ? "" : rest.slice(secondComma + 1);
      const type =
        declared === "plural" || declared === "select" ? (declared as "plural" | "select") : "value";

      const branches = new Set<string>();
      if (type !== "value") {
        for (const [branchKey, branchBody] of branchesOf(body)) {
          branches.add(branchKey);
          walk(branchBody);
        }
      }
      if (name !== "") found.set(name, { type, branches });
    }
  };

  walk(pattern);
  return found;
}

function closing(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevel(source: string, sep: string): number {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === sep && depth === 0) return i;
  }
  return -1;
}

function branchesOf(body: string): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;
    const keyStart = i;
    while (i < body.length && !/[\s{]/.test(body[i] ?? "")) i += 1;
    const key = body.slice(keyStart, i);
    while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;
    if (body[i] !== "{") break;
    const end = closing(body, i);
    if (end === -1) break;
    if (key !== "") out.push([key, body.slice(i + 1, end)]);
    i = end + 1;
  }
  return out;
}

/**
 * Render resolved catalogues as a report for a CI check.
 *
 * @param resolved - One entry per non-default locale.
 * @param floor    - Minimum acceptable coverage, 0–1. Defaults to 1.
 */
export function auditCatalogues(
  resolved: readonly ResolvedCatalogue<string>[],
  floor = 1,
): { ok: boolean; report: string } {
  const lines: string[] = [];
  let ok = true;

  for (const cat of resolved) {
    const pct = Math.round(cat.coverage * 100);
    const healthy = cat.rejected.length === 0 && cat.coverage >= floor;
    if (!healthy) ok = false;
    lines.push(`${healthy ? "ok  " : "FAIL"} ${cat.locale}  ${pct}% coverage`);

    for (const r of cat.rejected) {
      lines.push(`       ${r.key}  [${r.reason}] ${r.detail}`);
    }
    // Missing keys are listed but capped: a locale that has translated nothing
    // yet would otherwise bury the drift that actually needs fixing.
    if (cat.missing.length > 0) {
      const shown = cat.missing.slice(0, 10);
      lines.push(`       untranslated (${cat.missing.length}): ${shown.join(", ")}`);
      if (cat.missing.length > shown.length) {
        lines.push(`       …and ${cat.missing.length - shown.length} more`);
      }
    }
  }

  return { ok, report: lines.join("\n") };
}

// ── Rule 1.3 — content ───────────────────────────────────────────────────────

/**
 * What to do with a content item that has no translation for the current locale.
 *
 * `"hide"` is the policy for *compiled* content — publications, the whitepaper,
 * anything built once and surfaced everywhere. A Russian reader given an English
 * essay under Russian chrome learns that the locale is a veneer.
 *
 * `"fallback"` exists because the rule is not universally right, and pretending
 * otherwise would be the bug. A vacancy is the clear case: hiding an open role
 * from a Russian speaker who reads English fine costs a candidate, and loses more
 * than the inconsistency costs. Choose per collection, deliberately.
 */
export type MissingContentPolicy = "hide" | "fallback";

/**
 * Apply rule 1.3 to a content collection.
 *
 * @param locale    - The reader's locale.
 * @param items     - The full collection, in canonical (English) form.
 * @param localesOf - Which locales a given item has been translated into.
 * @param policy    - `"hide"` (default) or `"fallback"`.
 * @returns The items this locale should see.
 *
 * Bound to the generated registry; see {@link createPolicy} for your own.
 *
 * @example
 * ```ts
 * // Publications: hide what is not translated.
 * availableIn("ru", allPublications(), p => p.locales);
 *
 * // Vacancies: an open role is worth more than a consistent language.
 * availableIn("ru", vacancies, v => v.locales, "fallback");
 * ```
 */
export function availableIn<T>(
  locale: Locale,
  items: readonly T[],
  localesOf: (item: T) => readonly Locale[] | undefined,
  policy: MissingContentPolicy = "hide",
): T[] {
  return availableAgainst(DEFAULT_LOCALE, locale, items, localesOf, policy);
}

function availableAgainst<T, L extends string>(
  canonical: string,
  locale: L,
  items: readonly T[],
  localesOf: (item: T) => readonly L[] | undefined,
  policy: MissingContentPolicy,
): T[] {
  if (locale === canonical || policy === "fallback") return [...items];
  return items.filter(item => (localesOf(item) ?? []).includes(locale));
}
