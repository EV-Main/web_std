# @evinvest/i18n

A **dep-light** internationalisation toolkit for EV's five locales. It ships a
zero-dependency, server-safe **core** — locale registry, URL contract,
`Accept-Language` negotiation, and an ICU-subset message formatter — plus thin
**React** and **Next.js** subpaths.

> **Why this hard-codes its locales, unlike `@evinvest/experiments`.** That
> package deliberately never hard-codes experiment keys, because experiments are
> per-app. Locales are the opposite: the same five apply to the public site, the
> cabinet, and every MFE, and having one place they are declared is the whole
> point of putting this in a shared library. Helpers that iterate locales still
> accept an optional `locales` argument, so a surface shipping a subset is not
> forced to claim all five. A surface outside EV's five — a storefront with its
> own languages — builds its own registry; see
> [Your own locale set](#your-own-locale-set).

> **This package owns no number, date, or currency policy.** The formatter
> supports `plural` and `select` but deliberately not `number` / `date` /
> `currency`. Consuming apps keep **one policy per unit of measure** (see the
> cabinet's `shared/lib/money.ts`) and interpolate the already-formatted string.
> A second, competing number policy hiding inside message catalogues is exactly
> the drift that rule exists to prevent.

## Dep honesty

**Zero runtime dependencies.** `react` and `next` are **optional** peers
(declared in `peerDependenciesMeta`) — pull in only the subpath you use:

- `.` — pure core, no peers, server-safe, no React / Next / DOM. Enforced by
  `tsconfig.core.json`, which compiles `src/index.ts` with `lib: ["ES2022"]` and
  no `DOM`.
- `./react` — needs the `react` peer (a `"use client"` bundle).
- `./next` — needs the `next` peer only nominally; it imports nothing from
  `next` and returns plain data for `next.config.ts` and the metadata APIs.

`.` and `./next` ship **both ESM and CJS**. That is not symmetry for its own
sake: `next.config.ts` is loaded as CJS, so the ESM-only 0.1.0 could not be
`require`d there at all — it failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` in the
one file `localeRewrites`/`localeRedirects` exist to serve. `./react` stays
ESM-only, since a `"use client"` module is consumed by a bundler and never
`require`d from a config.

## Install

```sh
npm i @evinvest/i18n
```

Requires Node ≥ 20. `dist/` is built on publish, not committed.

## The locales

| Code | Label | Tier |
| ---- | ----- | ---- |
| `en` | English | authored source; fallback for anyone we cannot place |
| `ru` | Русский | human-reviewed |
| `vi` | Tiếng Việt | human-reviewed |
| `fr` | Français | machine translation accepted |
| `de` | Deutsch | machine translation accepted |

Vietnamese is **`vi`** — the ISO 639-1 *language* code. `vn` is the ISO 3166
*country* code and is not a valid `hreflang` or `lang` value; Google discards
invalid values silently, so the distinction is load-bearing.

## The URL contract

One rule, applied identically by the public site and the cabinet: **the default
locale is unprefixed, every other locale carries a `/<locale>` prefix.**

```
en  →  /team              ru  →  /ru/team
en  →  /cabinet/wallet    ru  →  /cabinet/ru/wallet
```

Unprefixed English means no already-indexed URL has to move, and no redirect
sits on the busiest route. `localePath` and `splitLocalePath` are the only place
that asymmetry may be expressed — hand-built locale URLs elsewhere drift
immediately.

```ts
import { localePath, splitLocalePath, localeAlternates } from "@evinvest/i18n";

localePath("ru", "/team");        // "/ru/team"
localePath("en", "/team");        // "/team"
splitLocalePath("/ru/team");      // { locale: "ru", path: "/team" }
splitLocalePath("/cabinet/x");    // { locale: "en", path: "/cabinet/x" }
localeAlternates("/team");        // { en: "/team", ru: "/ru/team", … }
```

`languageAlternates` is the `alternates.languages` value for Next's
`generateMetadata` — absolute URLs keyed by `hreflang`, plus `x-default` on the
default locale:

```ts
languageAlternates("/team", "https://evinvest.ltd");
// { en: "https://evinvest.ltd/team", ru: "https://evinvest.ltd/ru/team", …,
//   "x-default": "https://evinvest.ltd/team" }
```

## Your own locale set

Everything above is `createLocaleRegistry` applied to the generated five
(`defaultLocaleRegistry`). A surface with other languages builds its own and
gets the same contract over its own list:

```ts
// shared/config/i18n.ts
import { createLocaleRegistry } from "@evinvest/i18n";

export const i18n = createLocaleRegistry({
  locales: ["fr", "en"],                        // switcher order; literal union, no `as const` needed
  labels: { fr: "Français", en: "English" },
  default: "fr",                                // fallback, and the language `t()` is authored in
  prefixDefaultLocale: true,                    // default: false
  hreflang: { fr: "fr-FR" },                    // default: the bare code
});
export type Locale = (typeof i18n.locales)[number];   // "fr" | "en"

i18n.localePath("fr", "/contact");              // "/fr/contact"
i18n.splitLocalePath("/en/contact");            // { locale: "en", path: "/contact" }
i18n.languageAlternates("/contact", "https://plombier.fr");
// { "fr-FR": "https://plombier.fr/fr/contact", en: "https://plombier.fr/en/contact",
//   "x-default": "https://plombier.fr/fr/contact" }
```

The registry carries every locale-dependent function of the core —
`isLocale`, `localePath`, `splitLocalePath`, `localeAlternates`, `hreflangOf`,
`languageAlternates`, `negotiate`, `translator`, `formatMessage`,
`localeOfElement` — plus `locales`, `labels`, `defaultLocale` and
`prefixDefaultLocale`. Members are plain closures, so destructuring is safe. A
`default` outside `locales`, or a locale listed twice, is a type error and
throws at startup.

**`prefixDefaultLocale`.** `false` is EV's contract: the default locale lives at
bare paths so indexed URLs never move. `true` prefixes every locale — the shape
for a site launching in several languages with no legacy URLs. An unprefixed
path then still parses (as the default locale, never throwing), but nothing is
served there.

**`hreflang`.** Locale codes stay bare — they are URL segments and catalogue
directories. A regional target (`fr-FR`, `fr-BE`) is only how the page is
*advertised*, so it lives in this map and surfaces in `hreflangOf` and the
`alternates.languages` keys. Tags must be unique (bare-code fallbacks included,
case-insensitively) and `x-default` is reserved — both throw at startup.
`languageAlternates` adds `x-default` only when the locales it is given include
the default; `localeAlternatesMetadata` in `./next` always adds it, as it
always has.

The subpaths bind to a registry the same way; each defaults to the generated
one, which is what their free exports are:

```ts
import { createNextI18n } from "@evinvest/i18n/next";
export const { localeStaticParams, localeRewrites, localeRedirects, localeAlternatesMetadata } =
  createNextI18n(i18n);
```

With `prefixDefaultLocale: true`, `localeRewrites()` is empty — every locale is
a real `[locale]` route — and `localeRedirects()` only sends `/` to `/<default>`,
as a **temporary** redirect so a later change of default is not pinned in
browsers. Other bare paths 404 under `dynamicParams = false`; a catch-all
redirect would also match the prefixed routes and loop.

```tsx
"use client";
import { createI18nReact } from "@evinvest/i18n/react";
export const { I18nProvider, useLocale, useT } = createI18nReact(i18n);
```

Each `createI18nReact` call owns its own context: call it once, at module
scope, and import the trio from there.

The extractor bins are bound to the generated registry. For another set, a
three-line launcher of your own passes it through — `runExtract` / `runCheck`
treat every listed locale but the default as a translation:

```js
#!/usr/bin/env node
import { runCheck } from "@evinvest/i18n/extract";
import { i18n } from "../shared/config/i18n.js";
runCheck(process.argv.slice(2), i18n);
```

The free `resolveCatalogue` and `availableIn` in `./policy` treat `en` as the
source — the generated registry's default. Against a French-source registry
they would read French copy as fully covered in English, so bind the policy to
your registry instead:

```ts
import { createPolicy } from "@evinvest/i18n/policy";

const policy = createPolicy(i18n);                  // source = i18n.defaultLocale ("fr")
const { messages, coverage } = policy.resolveCatalogue("en", ids, enAuto, enOverrides);
policy.availableIn("en", posts, p => p.locales);    // "fr" always sees everything
```

`ev_lib::i18n::LocaleRegistry` is the Rust twin of a custom registry's URL
contract and negotiation. The formatter and policy stay bound to the generated
five there, their plural rules transcribed per locale by hand.

## Wiring a Next.js app

Routing is **config-level, not middleware**. Put every page under
`app/[locale]/`, then let one **`fallback`** rewrite serve the default locale at
unprefixed paths. `fallback` runs last — after dynamic routes — so prefixed
locale routes and zone mounts (`/cabinet`, `/rea`, `/api/*`) never reach it, and
the app keeps shipping no `proxy.ts` at all.

```ts
// next.config.ts
import { localeRewrites, localeRedirects } from "@evinvest/i18n/next";

const nextConfig = {
  async rewrites() {
    return { beforeFiles: [...zoneRewrites], afterFiles: [], fallback: localeRewrites() };
  },
  // Collapses /en/* onto the unprefixed form so each page has one canonical URL.
  async redirects() {
    return localeRedirects();
  },
};
```

> **Not `afterFiles`.** This is the one easy mistake, and it half-works, which is
> what makes it dangerous. Next's order is `redirects → beforeFiles → filesystem
> → afterFiles → dynamic routes → fallback`. The entire `app/[locale]/` tree is a
> *dynamic* route, so an `afterFiles` rule fires **before** `[locale]` is tried:
> `/ru/team` gets rewritten to `/en/ru/team` and 404s, while `/team` resolves
> correctly and hides the bug. Verified on Next 16.2.9 — see
> `site_conductor/docs/i18n-routing-spike.md`.

```tsx
// app/[locale]/layout.tsx
import { localeStaticParams } from "@evinvest/i18n/next";

export const dynamicParams = false;              // unknown first segment ⇒ 404
export const generateStaticParams = localeStaticParams;  // includes "en" — see below
```

`generateStaticParams` **must** include the default locale: unprefixed URLs are
*rewritten* onto `/en/*`, so those routes have to be really prerendered even
though no reader ever sees that URL.

`dynamicParams = false` is **load-bearing, not hygiene.** Since
`app/[locale]/page.tsx` is the homepage, `[locale]` matches any single segment —
so `/team` is ambiguous with it. With `dynamicParams = false`, `[locale]`
declines the unknown segment and the request falls through to the `fallback`
rewrite that resolves it as English. Without it, `/team` renders the homepage
with `locale === "team"`.

## The model

**English lives only where it renders, and is each string's identity.** There
are no keys:

```tsx
t("Invest in the China+1 narrative")
t("{n, plural, one {# item} other {# items}}", { n })
t.ctx("ledger", "Added")            // where one English means two things
```

A message's id is its English, or `ctx` + U+0004 + its English (gettext's
msgid; `messageId`). Identical English is one string with one translation.
Moving an element, renaming a component or a prop never touches a translation.

Every other locale is two flat files under `messages/`, both keyed by id:

```jsonc
// messages/ru.auto.json — generated, one entry per line, collapsed in PR diffs
{ "//": "GENERATED — overrides go in ru.json", "Invest in the China+1 narrative": "…" }
// messages/ru.json — hand-written overrides, laid over it
{ "Invest in the China+1 narrative": "Инвестируйте в нарратив «Китай+1»" }
```

Copy picked by data is a closed table, so every row's English is a literal:

```ts
const STATE = { draft: (t) => t("Draft"), verified: (t) => t("Verified") } satisfies Record<State, (t: T) => string>;
```

## The policy

Enforced by `@evinvest/i18n/policy` (and `ev_lib::i18n::policy`, canonical;
both run `tests/fixtures/i18n/policy.json`).

**1.1 — English is canonical.** It defines the set of strings, the placeholders
and the meaning; every other locale derives from it.

**1.2 — A translation that no longer matches its English is not used.** Because
the key *is* the English, an edited sentence leaves its old translation keyed by
text nothing renders: an orphan. An orphaned override stops applying — the new
English gets the generated translation — and `evinvest-i18n-check` fails,
naming the nearest new string so re-keying is one rename.

**1.3 — Compiled content with no translation for the current locale is hidden,**
not silently served in English. See `availableIn`.

Nothing compares *meaning* across languages. What is checkable is provenance
(the key) and **structure**: placeholders, argument types, and the plural
categories a locale requires — a Russian plural with only `one`/`other` is
provably wrong. An override failing structure gives way to the generated entry;
an id with neither accepted is missing.

```ts
import { resolveCatalogue } from "@evinvest/i18n/policy";

const { messages, rejected, missing } = resolveCatalogue("ru", ids, auto, overrides);
```

## Translating

`translator(messages, locale, onMissing)` — `onMissing` hears of an id the
catalogue lacks, which then renders its English. For the default locale the
catalogue is never read. Server Components call it directly:

```tsx
const t = translator(messagesFor(locale), locale, id => { throw new Error(id); });
return <h1>{t("The people behind the fund")}</h1>;
```

Client islands use the provider, mounted as high as the *client* tree goes.
`missing` is required, as data a Server Component layout can pass:
`"warn"` (once per id, then the English — development, where a new string is
pending by construction) or `"throw"` (a build the check passed has none).

```tsx
<I18nProvider locale={locale} messages={{ ...auto, ...overrides }} missing="throw">
  <WalletIsland />
</I18nProvider>
```

`I18nScope` lays its own `messages` over the provider's and inherits the locale
and `missing` — see [Slicing the catalogue](#slicing-the-catalogue).

## Slicing the catalogue

A client provider's `messages` are serialised into every page's RSC payload, so
a provider at the root layout ships the whole catalogue to every page. Slice it
instead: the provider carries what the layouts render, and each page's
`I18nScope` adds what that page renders. `pickMessages(messages, keys)` cuts the
slice; a key the catalogue lacks is left out, and the call site's English
renders for it as it would anyway.

```tsx
// app/[locale]/layout.tsx  (Server Component)
import { pickMessages } from "@evinvest/i18n";

<I18nProvider locale={locale} messages={pickMessages(messagesFor(locale), slices.shell)}>
```

Which keys go where is read off the app's import graph by
`evinvest-i18n-slices`, into a committed JSON file:

```sh
evinvest-i18n-slices --root frontend --exclude public,messages --config i18n-slices.config.json
evinvest-i18n-slices --root frontend --exclude public,messages --config i18n-slices.config.json --check
```

```json
{
  "//": "GENERATED by evinvest-i18n-slices …",
  "shell": ["nav.home", "…"],
  "routes": { "app/[locale]/wallet/page.tsx": ["wallet.title", "…"] },
  "serverOnly": ["meta.title", "…"]
}
```

- **Entries** are the App Router's own files under `app/` (or `src/app/`,
  `--app`): every `page`, and what wraps or replaces one — `layout`,
  `template`, `loading`, `error`, `not-found`, `forbidden`, `unauthorized`,
  `default`, `global-error`, `global-not-found`.
- **Client** is a file with `"use client"` and everything below it in the
  graph; only client files' `t()` keys go into a slice. Imports are static,
  re-exports, `import()` and `require`; `import type` is not followed.
  Aliases resolve through the tsconfig's `paths` and `baseUrl` (`--tsconfig`,
  default `<root>/tsconfig.json`).
- **`shell`** is every non-page entry's keys: they render outside any page's
  scope, so the provider carries them. **`routes`** maps each page to its keys
  minus the shell's — the page wraps its whole tree in
  `<I18nScope messages={pickMessages(catalogue, slices.routes[thisPage])}>`.
  **`serverOnly`** is every key under `--root` that no slice carries.

The generator errs only towards extra keys, because a missing one renders
English to a reader of another language without a sound. A local import that
does not resolve (relative, or matching a non-catch-all `paths` pattern), an
`import()` of a computed path, and a `t()` the extractor cannot read are
errors, not skips. So is a specifier no npm package can have — `@/x` (empty
scope), `~/x`, `#x` — that nothing maps: without a tsconfig it would otherwise
read as a package, and its keys would silently land in `serverOnly`. Graph
errors — an unresolved import, a computed `import()` — count only in files an
entry reaches: a test's `await import(spec)` feeds no slice, so it needs no
`--exclude`. An unreadable `t()` is an error anywhere under `--root`, as for
`evinvest-i18n-check`. `--check` fails when the file on disk differs from what the
code gives; keep the file out of the formatter, which would otherwise reflow
it into drift. With the JSON imported under `resolveJsonModule`, a mistyped
route key fails `tsc`.

A **closed table** of copy — `TIP_COPY[anchor](t)`, every row's `t()` in one
module — would put every row in every slice that imports it. A table rule
narrows it to the rows whose id appears as a string literal in a file the entry
reaches, server or client (a server page passing `anchor="wallet.x"` to a
client tip counts). A table is every top-level `const` in the module whose
initializer is an object literal of `t()` copy (through `satisfies`, `as`,
parentheses); each property is a row, its calls the row's copy:

```json
{ "tables": [{ "table": "shared/tips/copy.ts", "ignore": ["shared/tips/catalog.ts"] }] }
```

Calls outside every table stay ordinary copy of the module, and an English in
both a row and outside one stays carried. `ignore` lists files whose literals do
not count — the typed registry that names every id would otherwise select every
row.

**The rule's blind spot, and the one place the generator can miss a string.** It
sees a row id only as a whole string literal, in a file the entry reaches. An id
that reaches the table any other way is invisible, and nothing reports it:

- built at runtime: `` anchor={`wallet.${kind}`} ``, `"wallet." + kind`;
- from data: an API field, a URL parameter, a stored setting;
- from a file the entry does not reach, or one listed in `ignore`;
- from a package in `node_modules`, whose files are never read.

Keep every id a table is indexed with a literal in the code that renders it,
and run the app's end-to-end suite with `missing="throw"`: that is what catches
a row the rule did not see.

## Extracting

Two bins, same arguments, so a check and the extract that fixes it cannot be
pointed at different trees:

```sh
evinvest-i18n-extract --root frontend --exclude public,messages,tests
evinvest-i18n-check   --root frontend --exclude public,messages,tests
```

`--exclude` names what is **not** source, rather than what is. A list of source
directories is a hole that opens the day someone adds a slice, and an unscanned
call site produces no error — just English forever in five locales.
`--messages` defaults to `<root>/messages`.

All three bins (with `evinvest-i18n-slices` below) parse their arguments
strictly: `-h` / `--help` prints the usage and exits 0; an unknown flag, a flag
without its value, a repeated flag or a stray argument exits 2 before anything
is read or written — a tool that writes committed files must not read a typo as
"run with the defaults". A malformed `--config`, a missing `--root` and the like
also exit 2, with the message and no stack trace; exit 1 is the check itself
failing.

`extract` prunes every locale's two files to the ids the code renders, printing
each dropped override with the nearest new string. The prune is unconditional
because the scan cannot see a *deleted* call site — only what remains.

`check` is the build gate — put it in front of the app's `build`. Fatal: a
string with no accepted translation in some locale, an orphaned override (with
the nearest new string), a generated entry for English the code no longer
renders, a structural mismatch, and a locale with one of its two files.

Both refuse a `t()` whose English (or `t.ctx`'s context) is not a literal, and
the old `t("key", "English")` shape.

`evinvest-i18n-rekey` moves a consumer off 0.13's keys once: `t("k", "en", …)`
→ `t("en", …)`, `messages/<locale>/common.json` → `<locale>.json` overrides
(an entry whose stored `en` drifted is dropped and reported; two keys sharing
an English with different translations are reported for a `t.ctx`).

`typescript` is an optional peer dependency: needed to run the extractor, never
to render a string.

## An element remote's locale

A microfrontend mounted as a custom element gets its locale from the DOM it is
mounted *into*:

```ts
import { localeOfElement } from "@evinvest/i18n";

connectedCallback() { mount(this, localeOfElement(this)); }
```

Not a prop and not an attribute. A host mounts the element before it applies
attributes, so anything pushed in reads as `null` at `connectedCallback` time.
`lang` is the platform's own answer to "what language is this subtree", it is
already set correctly by every host that serves more than one, and it is
readable the instant the node is attached. `ev_lib::mfe::host_locale` is the
Rust mirror.

## Message patterns

A deliberately small ICU subset:

| Form | Example |
| ---- | ------- |
| interpolation | `Hello, {name}.` |
| plural | `{n, plural, =0 {no roles} one {# role} other {# roles}}` |
| select | `{tier, select, fund {Fund} other {Guest}}` |
| escaping | `'{'` and `'}'` for literal braces, `''` for an apostrophe |

`#` inside a plural branch renders the count **in the reader's locale** — `ru`
groups thousands with spaces, `de` with dots.

Plural categories come from `Intl.PluralRules`, which is why this is not a bare
string map: Russian has `one` / `few` / `many`, Vietnamese has only `other`.

```ts
formatMessage("{n, plural, one {# вакансия} few {# вакансии} many {# вакансий}}", "ru", { n: 3 });
// "3 вакансии"
```

Apostrophes in ordinary copy are left alone — the ICU 4.8 "apostrophe-friendly"
rules apply, so a quote only starts a quoted section when it immediately precedes
`{`, `}` or `#`. `We've got it.` survives intact.

## Negotiation is for *suggesting*, not serving

`negotiate()` reads an `Accept-Language` header with q-values and regional
fallback (`ru-RU` → `ru`). Use it to decide which locale to **offer** — the
"read this in your language" strip — never to decide what to serve. EV serves the
default locale at unprefixed URLs and does not auto-redirect: Google crawls in
English from a US IP, so a language redirect can bury the other locales, and a
reader who deliberately chose English should not be bounced out of it.

## Rust counterpart

`ev_lib`'s `i18n` feature mirrors this package: the same registry, the same URL
contract, the same formatter, the same policy, and the same call shape via the
`t!` macro (`t!(tr, "en")`, `t!(tr, ctx = "…", "en")`). It reads the *same*
catalogues, so they are portable between the two halves and neither can drift
alone: both suites run the vectors in `tests/fixtures/i18n/`. Its extractor is the linker rather than a parser — a `t!` site that
compiles is registered — which is why the Rust half needs no equivalent of the
bins above.

## Scripts

```sh
npm run build      # tsup → dist/ (ESM; plus CJS for `.` and `./next`)
npm test           # vitest: node project for the core + next, jsdom for react
npm run typecheck  # full tsconfig, then the DOM-free core tsconfig
npm run preflight  # dry run for a release — checks everything, publishes nothing
```

## Release

Releases go through the repo-wide script, never `npm publish` from here — see
AGENTS.md for why (a hand publish skips the bump and the tag, and the tag is what
decides what gets released next time).

```sh
npm run preflight                                   # from ts/i18n — verify first
cd "$(git rev-parse --show-toplevel)"
nix run .#publish -- minor              # bumps, commits, tags, pushes; CI publishes the tag
```

`publish.rs` walks `ts/*` and treats a package with no `<name>-v*` tag as never
published, so this one is picked up automatically — nothing to register. It bumps
**before** publishing, which is why the manifest sits at `0.0.0`: `-- minor`
makes the first release `0.1.0`.

Two things to know for this first release:

- **A granular npm token probably cannot create it.** Granular tokens list the
  packages they may write to, and a package that does not exist yet cannot be on
  that list. npm reports the refusal as a 404, which is indistinguishable from
  "not found" — `publish.rs` says as much in its failure output. Use an
  automation or classic token with `@evinvest` write access for the first
  publish; granular is fine afterwards.
- **`prepublishOnly` runs `verify-pack.mjs`,** which refuses to publish a tarball
  that does not contain what `exports` promises. It follows each entry point's
  own imports rather than checking a fixed list, because `.`, `./react` and
  `./next` share a hash-named chunk whose filename changes every build — a
  missing chunk passes every `files`-field check and then throws
  `ERR_MODULE_NOT_FOUND` in the consumer.
