/**
 * @module @evinvest/i18n/react
 *
 * React bindings — a provider and two hooks, for **client islands only**.
 *
 * Server Components need nothing from this file: they call `translator()` from
 * the core directly, since the locale is already in their props (it comes off
 * the `[locale]` route segment) and there is no re-render to memoise against.
 * Both consuming apps mandate Server Components by default with `"use client"`
 * pushed to the smallest leaf, so reaching for this provider is the exception —
 * an island that genuinely needs to translate inside interactive state.
 *
 * The whole subpath carries the `"use client"` banner, which is exactly why the
 * core stays separate: importing the registry or `localePath` from a Server
 * Component must not drag a client boundary along with it.
 *
 * The named exports are bound to the generated registry; {@link createI18nReact}
 * binds the same set to a registry of your own.
 */
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  defaultLocaleRegistry,
  type Locale,
  type LocaleRegistry,
  type Messages,
  type Translate,
} from "../index";

/** Props for {@link I18nProvider}. */
export interface I18nProviderProps<L extends string = Locale> {
  /** The active locale, from the `[locale]` route segment. */
  locale: L;
  /** The catalogue for `locale`, loaded on the server and serialised in. */
  messages: Messages;
  /** Also hears of every id the catalogue lacks — wire to Sentry in production. */
  onMissing?: (id: string, locale: L) => void;
  /**
   * What an id the catalogue lacks does, as plain data a Server Component layout can pass:
   *
   * - `"warn"` — `console.warn` once per id, then render the English: pending, in development.
   * - `"throw"` — throw from the render: a build the i18n check passed has none.
   *
   * Never fires for the default locale, which reads no catalogue.
   */
  missing: MissingMode;
  children: ReactNode;
}

/** See {@link I18nProviderProps.missing}. */
export type MissingMode = "warn" | "throw";

/**
 * `onMissing` with {@link MissingMode} folded in. `onMissing` is read through a
 * getter and `warned` is passed in, so neither a new `onMissing` each render nor
 * a rebuilt reporter forgets which keys were already warned about.
 */
function reporter<L extends string>(
  mode: MissingMode,
  onMissing: () => ((id: string, locale: L) => void) | undefined,
  warned: Set<string>,
): (id: string, locale: L) => void {
  return (id, locale) => {
    onMissing()?.(id, locale);
    const message = `@evinvest/i18n: ${JSON.stringify(id)} has no ${locale} translation in the catalogue this tree was given`;
    if (mode === "throw") {
      throw new Error(
        `${message}. Run evinvest-i18n-check; if the catalogue is sliced, regenerate the slices ` +
          `(evinvest-i18n-slices) or check that the page wraps its tree in <I18nScope>.`,
      );
    }
    const seen = `${locale}:${id}`;
    if (warned.has(seen)) return;
    warned.add(seen);
    console.warn(`${message}; rendering the English.`);
  };
}

/** Props for {@link I18nScope}. Plain data, so a Server Component can render it. */
export interface I18nScopeProps {
  /**
   * More messages for the subtree, laid over the enclosing catalogue — a route's
   * slice of a catalogue whose shell the provider already carries. An id in
   * both reads from this one.
   */
  messages: Messages;
  children: ReactNode;
}

/** The provider, the scope and the hooks for one registry. */
export interface I18nReact<L extends string> {
  readonly I18nProvider: (props: I18nProviderProps<L>) => ReactElement;
  readonly I18nScope: (props: I18nScopeProps) => ReactElement;
  readonly useLocale: () => L;
  readonly useT: () => Translate;
}

/**
 * Bind the provider and hooks to a registry built with `createLocaleRegistry`.
 * Call it once at module scope in a `"use client"` file and re-export the
 * result: each call owns its own context, so a provider from one call is
 * invisible to hooks from another.
 *
 * @example
 * ```tsx
 * "use client";
 * export const { I18nProvider, useLocale, useT } = createI18nReact(i18n);
 * ```
 */
export function createI18nReact<L extends string>(registry: LocaleRegistry<L>): I18nReact<L> {
  type Report = (id: string, locale: L) => void;
  // `messages` and `report` ride along so a nested scope can rebuild `t` over a
  // wider catalogue without being handed either again.
  type Value = { locale: L; messages: Messages; report: Report; t: Translate };
  const I18nContext = createContext<Value | null>(null);

  function I18nProvider({ locale, messages, onMissing, missing, children }: I18nProviderProps<L>) {
    // An inline `onMissing` is a new function every render. Read through a ref, it
    // neither rebuilds `t` (re-rendering every consumer) nor resets `warned`. It is
    // written during render, not in an effect, so the render that brings a new
    // handler already reports to it.
    const latest = useRef(onMissing);
    latest.current = onMissing;
    // Per provider rather than per module: an id warned about under one tree is
    // still news under another, and a re-render must not repeat it.
    const warned = useRef<Set<string>>(new Set());
    const report = useMemo(
      () => reporter<L>(missing, () => latest.current, warned.current),
      [missing],
    );
    const value = useMemo<Value>(
      () => ({ locale, messages, report, t: registry.translator(messages, locale, report) }),
      [locale, messages, report],
    );
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
  }

  function I18nScope({ messages, children }: I18nScopeProps) {
    const parent = useContext(I18nContext);
    const value = useMemo<Value | null>(() => {
      if (parent === null) return null;
      // The default locale never reads its catalogue, so a wider one changes nothing.
      if (parent.locale === registry.defaultLocale) return parent;
      const merged: Messages = { ...parent.messages, ...messages };
      return {
        locale: parent.locale,
        messages: merged,
        report: parent.report,
        t: registry.translator(merged, parent.locale, parent.report),
      };
    }, [parent, messages]);
    if (value === null) {
      // A scope only widens a catalogue; the locale is the provider's to decide,
      // and guessing it here would render one language inside another.
      throw new Error(
        `<I18nScope> requires an <I18nProvider> above it from the same registry ` +
          `(locales [${registry.locales.join(", ")}], default "${registry.defaultLocale}"). ` +
          `It adds messages to the provider's catalogue and takes the locale from it.`,
      );
    }
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
  }

  function useI18n(hook: string): Value {
    const value = useContext(I18nContext);
    if (value === null) {
      // A wiring bug, not a content gap: without a provider the locale itself is
      // unknown, so there is nothing sensible to degrade to. Fail loudly and
      // immediately rather than silently rendering one locale inside another.
      // Names the registry because a provider from another createI18nReact()
      // call is invisible here, and that is the non-obvious way to hit this.
      throw new Error(
        `${hook}() requires an <I18nProvider> above it from the same registry ` +
          `(locales [${registry.locales.join(", ")}], default "${registry.defaultLocale}"). ` +
          `Server Components should call translator() from @evinvest/i18n instead — ` +
          `or registry.translator() for a registry built with createLocaleRegistry.`,
      );
    }
    return value;
  }

  const useLocale = (): L => useI18n("useLocale").locale;
  const useT = (): Translate => useI18n("useT").t;

  return { I18nProvider, I18nScope, useLocale, useT };
}

const bound: I18nReact<Locale> = createI18nReact(defaultLocaleRegistry);

/**
 * Supplies locale and catalogue to client islands beneath it.
 *
 * Mount it as high as the *client* tree goes — typically wrapping the interactive
 * subtree inside a Server layout, not the whole document. Passing the catalogue
 * as a prop means it is serialised into the RSC payload once, so keep per-route
 * catalogues narrow rather than shipping every namespace to every page.
 *
 * @example
 * ```tsx
 * // app/[locale]/layout.tsx  (Server Component)
 * <I18nProvider locale={locale} messages={await load(locale)} missing="throw">
 *   <WalletIsland />
 * </I18nProvider>
 * ```
 */
export const I18nProvider: (props: I18nProviderProps) => ReactElement = bound.I18nProvider;

/**
 * Widens the enclosing provider's catalogue for the subtree beneath it: its
 * `messages` are laid over the provider's (`{ ...parent, ...own }`), and the
 * locale and the missing-key handling are inherited.
 *
 * This is what lets a layout ship only the messages its own chrome renders and each
 * page add its own: the provider carries the shell, the page's scope carries the
 * route (see `pickMessages` and `evinvest-i18n-slices`). Scopes nest; the
 * nearest one wins an id both carry.
 *
 * @throws If no {@link I18nProvider} is mounted above.
 *
 * @example
 * ```tsx
 * // app/[locale]/wallet/page.tsx  (Server Component)
 * <I18nScope messages={pickMessages(messagesFor(locale), slices.routes[ROUTE])}>
 *   <WalletIsland />
 * </I18nScope>
 * ```
 */
export const I18nScope: (props: I18nScopeProps) => ReactElement = bound.I18nScope;

/**
 * The active locale inside a client island.
 *
 * @returns The locale supplied by the nearest {@link I18nProvider}.
 * @throws If no provider is mounted above.
 */
export const useLocale: () => Locale = bound.useLocale;

/**
 * The translate function for the active locale and catalogue.
 *
 * @returns A {@link Translate}.
 * @throws If no provider is mounted above.
 *
 * @example
 * ```tsx
 * const t = useT();
 * return <button>{t("Deposit")}</button>;
 * ```
 */
export const useT: () => Translate = bound.useT;
