import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLocaleRegistry,
  defaultLocaleRegistry,
  hreflangOf,
  isLocale,
  languageAlternates,
  localeAlternates,
  localePath,
  LOCALES,
  negotiate,
  splitLocalePath,
  type LocaleList,
  type LocaleRegistry,
  type LocaleRegistryConfig,
} from "../src/index";
import { pruneCatalogues, serialiseAuto, translatedLocales } from "../src/extract/index";
import { createNextI18n } from "../src/next/index";
import { availableIn, createPolicy, resolveCatalogue } from "../src/policy/index";

// The shape the Service-Arb storefronts need: French first and default, every
// locale prefixed, French advertised to France specifically.
const fr = createLocaleRegistry({
  locales: ["fr", "en"],
  labels: { fr: "Français", en: "English" },
  default: "fr",
  prefixDefaultLocale: true,
  hreflang: { fr: "fr-FR" },
});

const SITE = "https://plombier.example";

// Shared with ev_lib::i18n (rust/tests/i18n.rs).
type Config = LocaleRegistryConfig<LocaleList>;
const VECTORS = JSON.parse(readFileSync(join(import.meta.dirname, "../../../tests/fixtures/i18n/registry.json"), "utf8")) as {
  registries: Record<string, Config>;
  isLocale: [string, string, boolean][];
  localePath: [string, string, string, string][];
  splitLocalePath: [string, string, string, string][];
  roundTrip: [string, string[]][];
  localeAlternates: [string, string, string[] | null, [string, string][]][];
  hreflangOf: [string, string, string][];
  languageAlternates: [string, string, string, [string, string][]][];
  negotiate: [string, string | null, string[] | null, string][];
  invalid: [Config, string, string | null][];
};

// `ev` runs the free functions, which are the generated registry.
const generated = {
  locales: LOCALES,
  isLocale,
  localePath,
  splitLocalePath,
  localeAlternates,
  hreflangOf,
  languageAlternates,
  negotiate,
} as unknown as LocaleRegistry<string>;
const registry = (name: string): LocaleRegistry<string> => {
  if (name === "ev") return generated;
  const config = VECTORS.registries[name];
  if (config === undefined) throw new Error(`no registry ${name}`);
  return createLocaleRegistry(config);
};
const subset = (locales: string[] | null) => locales ?? undefined;

describe("shared vectors", () => {
  it.each(VECTORS.isLocale)("%s: isLocale(%j) is %s", (name, value, expected) => {
    expect(registry(name).isLocale(value)).toBe(expected);
  });

  it.each(VECTORS.localePath)("%s serves %s at %j as %s", (name, locale, path, expected) => {
    expect(registry(name).localePath(locale, path)).toBe(expected);
  });

  it.each(VECTORS.splitLocalePath)("%s splits %j into %s %s", (name, pathname, locale, path) => {
    expect(registry(name).splitLocalePath(pathname)).toEqual({ locale, path });
  });

  it.each(VECTORS.roundTrip)("%s: splitLocalePath inverts localePath on %j", (name, paths) => {
    const r = registry(name);
    for (const locale of r.locales) {
      for (const path of paths) expect(r.splitLocalePath(r.localePath(locale, path))).toEqual({ locale, path });
    }
  });

  it.each(VECTORS.localeAlternates)("%s: alternates of %s over %j", (name, path, locales, expected) => {
    expect(Object.entries(registry(name).localeAlternates(path, subset(locales)))).toEqual(expected);
  });

  it.each(VECTORS.hreflangOf)("%s advertises %s as %s", (name, locale, tag) => {
    expect(registry(name).hreflangOf(locale)).toBe(tag);
  });

  it.each(VECTORS.languageAlternates)("%s: language alternates of %s on %s", (name, path, site, expected) => {
    expect(Object.entries(registry(name).languageAlternates(path, site))).toEqual(expected);
  });

  it.each(VECTORS.negotiate)("%s negotiates %j over %j to %s", (name, header, locales, expected) => {
    expect(registry(name).negotiate(header, subset(locales))).toBe(expected);
  });

  it.each(VECTORS.invalid)("refuses %j (%s)", config => {
    expect(() => createLocaleRegistry(config)).toThrow();
  });
});

describe("createLocaleRegistry — types", () => {
  it("narrows the locale type to the literal union of `locales`", () => {
    const locale: "fr" | "en" = fr.defaultLocale;
    expect(locale).toBe("fr");
    // @ts-expect-error — "de" is not in this registry
    fr.localePath("de", "/x");
  });

  it("rejects a default outside the list, at compile time and at startup", () => {
    expect(() =>
      createLocaleRegistry({
        locales: ["fr", "en"],
        labels: { fr: "Français", en: "English" },
        // @ts-expect-error — "de" is not one of `locales`
        default: "de",
      }),
    ).toThrow(/not in \[fr, en\]/);
  });

  it("keeps its members bound when destructured", () => {
    const { localePath } = fr;
    expect(localePath("en", "/a")).toBe("/en/a");
  });
});

describe("hreflang", () => {
  it("omits x-default for a subset that does not advertise the default", () => {
    expect(fr.languageAlternates("/", SITE, ["en"])).toEqual({ en: "https://plombier.example/en" });
    expect(fr.languageAlternates("/", SITE, ["fr"])).toEqual({
      "fr-FR": "https://plombier.example/fr",
      "x-default": "https://plombier.example/fr",
    });
  });
});

describe("translation follows the registry's default", () => {
  it("treats the default locale as the authored source", () => {
    const fail = (id: string) => {
      throw new Error(id);
    };
    const t = fr.translator({ "Appelez-nous": "IGNORED" }, "fr", fail);
    expect(t("Appelez-nous")).toBe("Appelez-nous");
    const en = fr.translator({ "Appelez-nous": "Call us" }, "en", fail);
    expect(en("Appelez-nous")).toBe("Call us");
  });

  it("reads lang inheritance against its own list", () => {
    const node = { getAttribute: () => "en-US", closest: () => node };
    expect(fr.localeOfElement(node)).toBe("en");
  });
});

describe("the generated registry is the default instance", () => {
  it("is what the free functions delegate to", () => {
    expect(defaultLocaleRegistry.locales).toEqual(LOCALES);
    expect(defaultLocaleRegistry.prefixDefaultLocale).toBe(false);
  });
});

describe("createNextI18n", () => {
  const next = createNextI18n(fr);

  it("prerenders every locale", () => {
    expect(next.localeStaticParams()).toEqual([{ locale: "fr" }, { locale: "en" }]);
  });

  it("needs no fallback rewrite when nothing is served unprefixed", () => {
    expect(next.localeRewrites()).toEqual([]);
  });

  it("sends only the bare root to the default locale, temporarily", () => {
    expect(next.localeRedirects()).toEqual([{ source: "/", destination: "/fr", permanent: false }]);
  });

  it("emits a prefixed canonical and the hreflang cluster", () => {
    expect(next.localeAlternatesMetadata("fr", "/contact", SITE)).toEqual({
      canonical: "https://plombier.example/fr/contact",
      languages: {
        "fr-FR": "https://plombier.example/fr/contact",
        en: "https://plombier.example/en/contact",
        "x-default": "https://plombier.example/fr/contact",
      },
    });
  });

  it("keeps x-default in the metadata for a subset, as it always has", () => {
    expect(next.localeAlternatesMetadata("en", "/", SITE, ["en"]).languages).toEqual({
      en: "https://plombier.example/en",
      "x-default": "https://plombier.example/fr",
    });
  });

  it("keeps the unprefixed scheme for a registry that does not prefix", () => {
    const plain = createNextI18n(
      createLocaleRegistry({
        locales: ["fr", "en"],
        labels: { fr: "Français", en: "English" },
        default: "fr",
      }),
    );
    expect(plain.localeRewrites()).toEqual([{ source: "/:path*", destination: "/fr/:path*" }]);
    expect(plain.localeRedirects()).toContainEqual({
      source: "/fr/:path*",
      destination: "/:path*",
      permanent: true,
    });
  });
});

describe("policy and extract take the registry's source locale", () => {
  it("does not count English as covered when the source is French", () => {
    // The bug a default-registry policy would have: `en` is its source, so an
    // empty English catalogue over French copy reads as 100 % translated.
    const source = ["Appelez-nous"];
    expect(resolveCatalogue("en", source, {}, {}).coverage).toBe(1);

    const policy = createPolicy(fr);
    const en = policy.resolveCatalogue("en", source, {}, {});
    expect(en.coverage).toBe(0);
    expect(en.missing).toEqual(source);
    expect(policy.resolveCatalogue("fr", source, {}, {}).coverage).toBe(1);
  });

  it("names the registry's source locale in rejections", () => {
    const n = "{n, plural, one {# appel} other {# appels}}";
    const resolved = createPolicy(fr).resolveCatalogue("en", [n], { [n]: "{n} calls" }, {});
    expect(resolved.rejected[0]?.detail).toMatch(/is a plural in fr/);
  });

  it("hides untranslated content from every locale but the registry's source", () => {
    const policy = createPolicy(fr);
    expect(policy.availableIn("fr", ["a"], () => [])).toEqual(["a"]);
    expect(policy.availableIn("en", ["a"], () => [])).toEqual([]);
    expect(policy.availableIn("en", ["a"], () => ["en"])).toEqual(["a"]);
    expect(availableIn("en", ["a"], () => [])).toEqual(["a"]);
  });

  it("prunes every non-source locale's catalogues to what the code renders", () => {
    const messages = mkdtempSync(join(tmpdir(), "i18n-registry-"));
    writeFileSync(join(messages, "en.auto.json"), serialiseAuto("en", { "Appelez-nous": "Call us", stale: "y" }));
    writeFileSync(join(messages, "en.json"), JSON.stringify({ gone: "z" }));

    expect(translatedLocales(messages, fr)).toEqual(["en"]);
    const lines = pruneCatalogues(messages, [{ id: "Appelez-nous", en: "Appelez-nous", where: "a.tsx:1" }], fr);

    expect(lines[0]).toBe("fr: 1 strings in the code");
    expect(readFileSync(join(messages, "en.auto.json"), "utf8")).toBe(serialiseAuto("en", { "Appelez-nous": "Call us" }));
    expect(JSON.parse(readFileSync(join(messages, "en.json"), "utf8"))).toEqual({});
    expect(lines.join("\n")).toMatch(/override dropped: "gone".*\n.*nearest now: "Appelez-nous" \(a\.tsx:1\)/);
  });
});
