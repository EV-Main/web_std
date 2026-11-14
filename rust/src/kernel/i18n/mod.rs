//! `i18n` — five-locale internationalisation (mirrors `@evinvest/i18n`).
//!
//! Zero-dependency and `wasm32`-safe: the locale registry, the URL contract,
//! `Accept-Language` negotiation, a small ICU-subset message formatter over
//! caller-supplied catalogues, and the translation [`policy`].
//!
//! This is the Rust half of a contract the TypeScript package already defines.
//! It exists because `real_estate_allocation` is a Dioxus app that cannot import
//! an npm package, and a zone rendering English chrome under a Russian shell is
//! the exact failure the shared registry was created to prevent. Both halves
//! read **the same `messages/<locale>/*.json` files** and apply the same rules,
//! so a catalogue is portable between them and neither can drift alone.
//!
//! **Why this hard-codes its locales**, unlike [`experiments`](crate::experiments):
//! experiment keys are per-app, but the same five locales apply to the public
//! site, the cabinet and every MFE, and having one place they are declared is the
//! entire point of putting this in a shared library. Helpers that iterate locales
//! still take a `locales` slice, so a surface shipping a subset is not forced to
//! claim all five. A surface outside that set — a brand landing that is `fr` by
//! default and prefixes every locale — builds a [`LocaleRegistry`] over its own
//! list and gets the same URL contract and negotiation.
//!
//! **Formatting numbers and money is deliberately NOT this module's job.** The
//! formatter supports `plural` and `select` but not `number`, `date` or
//! `currency`: consuming apps own one policy per unit of measure and interpolate
//! the already-formatted string. A second, competing number policy hiding inside
//! message catalogues is exactly the drift that rule exists to prevent. The one
//! exception is `#` inside a plural branch, which is the count itself — see
//! [`Locale::format_number`].
//!
//! **English lives only where it renders, and is the string's identity.** A
//! catalogue is keyed by the English it translates (plus a `ctx` where one English
//! string means two things), so there is no key to write, and a translation whose
//! English changed no longer matches anything — see [`policy`].
//!
//! ```
//! use ev_lib::{i18n::{Locale, Messages, Translator}, t};
//!
//! let en = "{n, plural, one {# item} other {# items}}";
//! let mut messages = Messages::new();
//! messages.insert(en.into(), "{n, plural, one {# товар} few {# товара} many {# товаров}}".into());
//! messages.insert("cart\u{4}Added".into(), "Добавлен".into());
//! let tr = Translator::new(messages, Locale::Ru);
//!
//! assert_eq!(t!(tr, "{n, plural, one {# item} other {# items}}", n = 3.0), "3 товара");
//! assert_eq!(t!(tr, ctx = "cart", "Added"), "Добавлен");
//! ```

use std::collections::BTreeMap;

mod format;
mod plural;
pub mod policy;
mod registry;
#[cfg(test)]
mod tests;

pub use format::{MessageValue, MessageValues, format_message};
pub use plural::PluralCategory;
pub use registry::{LocaleRegistry, LocaleRegistryConfig, RegistryError};

/// The locales EV publishes, in the order they are offered to a reader.
/// `En` is first because it is both the default and the authored source.
pub const LOCALES: [Locale; 5] = [Locale::En, Locale::Ru, Locale::Vi, Locale::Fr, Locale::De];

/// The authored source locale, and the fallback for any reader we cannot place.
/// Also the only locale whose URLs carry no prefix — see [`locale_path`].
pub const DEFAULT_LOCALE: Locale = Locale::En;

/// A loaded catalogue: message id → pattern. `BTreeMap` so a report's order is deterministic.
pub type Messages = BTreeMap<String, String>;

/// Between a message's `ctx` and its English in its id — gettext's.
pub const CTX_SEPARATOR: char = '\u{4}';

/// A message's identity: its English, prefixed by its `ctx` where it has one.
pub fn message_id(ctx: Option<&str>, en: &str) -> String {
	match ctx {
		Some(ctx) => format!("{ctx}{CTX_SEPARATOR}{en}"),
		None => en.to_owned(),
	}
}

impl Locale {
	/// The BCP 47 language subtag — what goes in `<html lang>` and a URL prefix.
	pub fn code(self) -> &'static str {
		match self {
			Self::En => "en",
			Self::Ru => "ru",
			Self::Vi => "vi",
			Self::Fr => "fr",
			Self::De => "de",
		}
	}

	/// This locale's name **in that locale** — what a language switcher must show.
	///
	/// A reader who cannot read the current language cannot read "Russian"
	/// either, so a switcher that localises its own option labels is unusable to
	/// the very person reaching for it.
	pub fn label(self) -> &'static str {
		match self {
			Self::En => "English",
			Self::Ru => "Русский",
			Self::Vi => "Tiếng Việt",
			Self::Fr => "Français",
			Self::De => "Deutsch",
		}
	}

	/// Parse untrusted input — a URL segment, a cookie, a query param.
	///
	/// ```
	/// use ev_lib::i18n::Locale;
	/// assert_eq!(Locale::parse("ru"), Some(Locale::Ru));
	/// assert_eq!(Locale::parse("vn"), None); // country code, not a language code
	/// ```
	pub fn parse(value: &str) -> Option<Self> {
		LOCALES.into_iter().find(|l| l.code() == value)
	}
}

impl std::fmt::Display for Locale {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.code())
	}
}

impl std::str::FromStr for Locale {
	type Err = UnknownLocale;

	fn from_str(s: &str) -> Result<Self, Self::Err> {
		Self::parse(s).ok_or_else(|| UnknownLocale(s.to_owned()))
	}
}

impl std::fmt::Display for UnknownLocale {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "unknown locale {:?} — EV publishes en, ru, vi, fr, de", self.0)
	}
}

impl std::error::Error for UnknownLocale {}

// ── URL contract ─────────────────────────────────────────────────────────────
//
// One rule, applied identically by the public site, the cabinet and every zone:
// the default locale is unprefixed, every other locale carries a `/<locale>`
// prefix.
//
//   en → /team          ru → /ru/team
//
// Unprefixed English means no already-indexed URL has to move and no redirect
// sits on the busiest route. The cost is that these functions are the only place
// that asymmetry may be expressed — hand-built locale URLs elsewhere drift
// immediately.

// ── Messages ─────────────────────────────────────────────────────────────────

impl Translator {
	/// Bind `messages` to `locale`.
	pub fn new(messages: Messages, locale: Locale) -> Self {
		Self { messages, locale }
	}

	/// The locale this translator renders in.
	pub fn locale(&self) -> Locale {
		self.locale
	}

	/// Render `en` (under `ctx`, if given); what [`t!`](crate::t) expands to.
	///
	/// A translation the catalogue lacks renders `en` in a debug build and panics in a release one:
	/// the policy's check refuses to build past one.
	pub fn render(&self, ctx: Option<&str>, en: &str, values: &MessageValues) -> String {
		if self.locale == DEFAULT_LOCALE {
			return format_message(en, self.locale, values);
		}
		let id = message_id(ctx, en);
		let pattern = match self.messages.get(&id) {
			Some(pattern) => pattern.as_str(),
			None if cfg!(debug_assertions) => en,
			None => panic!("{id:?} has no {} translation; the i18n check lets no build past this", self.locale),
		};
		format_message(pattern, self.locale, values)
	}
}

/// Look up one string, and register it for extraction.
///
/// ```
/// use ev_lib::{i18n::{Locale, Messages, Translator}, t};
/// let tr = Translator::new(Messages::new(), Locale::En);
///
/// t!(tr, "Invest in the China+1 narrative");
/// t!(tr, "{n, plural, one {# item} other {# items}}", n = 2);
/// t!(tr, ctx = "tokens", "Added");
/// ```
///
/// `$en` and `$ctx` are `literal` fragments, so **the compiler is the literal-ness gate** — the
/// TypeScript extractor has to enforce that by hand.
///
/// Natively, each site also registers itself with [`i18n::catalogue`](catalogue): extraction is
/// *linking*, so a site that compiles is registered whether or not it ever renders. The ceiling:
/// **copy must live in natively-compilable code.**
#[cfg(feature = "i18n")]
#[macro_export]
macro_rules! t {
	($tr:expr, ctx = $ctx:literal, $en:literal $(, $name:ident = $value:expr)* $(,)?) => {{
		$crate::__i18n_register!(::core::option::Option::Some($ctx), $en);
		let values: $crate::i18n::MessageValues = [$((stringify!($name).to_owned(), $crate::i18n::MessageValue::from($value))),*].into_iter().collect();
		$tr.render(::core::option::Option::Some($ctx), $en, &values)
	}};
	($tr:expr, $en:literal $(, $name:ident = $value:expr)* $(,)?) => {{
		$crate::__i18n_register!(::core::option::Option::None, $en);
		let values: $crate::i18n::MessageValues = [$((stringify!($name).to_owned(), $crate::i18n::MessageValue::from($value))),*].into_iter().collect();
		$tr.render(::core::option::Option::None, $en, &values)
	}};
}

/// The registration half of [`t!`], which is a no-op on `wasm32` so the shipped
/// bundle carries no extraction machinery.
#[cfg(all(feature = "i18n", not(target_arch = "wasm32")))]
#[doc(hidden)]
#[macro_export]
macro_rules! __i18n_register {
	($ctx:expr, $en:literal) => {
		$crate::i18n::inventory::submit! { $crate::i18n::Source { ctx: $ctx, en: $en } }
	};
}

#[cfg(all(feature = "i18n", target_arch = "wasm32"))]
#[doc(hidden)]
#[macro_export]
macro_rules! __i18n_register {
	($ctx:expr, $en:literal) => {};
}

// ── Extraction ───────────────────────────────────────────────────────────────

#[cfg(not(target_arch = "wasm32"))]
pub use inventory;

/// A catalogue bound to one locale, ready to render — through [`t!`](crate::t).
///
/// For [`Locale::En`] the catalogue is never consulted: its copy is the call site's.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Translator {
	messages: Messages,
	locale: Locale,
}

/// Pick the best locale for an `Accept-Language` header, honouring q-values and
/// matching a bare language against a regional tag (`ru-RU` → `ru`).
///
/// Note what this is *for*. EV serves the default locale at unprefixed URLs and
/// never auto-redirects on it — Google crawls in English from a US IP, so a
/// language redirect can bury the other locales, and a reader who deliberately
/// chose English should not be bounced out of it. Use this to decide which
/// locale to *suggest*, not what to serve.
///
/// ```
/// use ev_lib::i18n::{LOCALES, Locale, negotiate};
/// assert_eq!(negotiate(Some("ru-RU,ru;q=0.9,en;q=0.8"), &LOCALES), Locale::Ru);
/// assert_eq!(negotiate(Some("ja,ko;q=0.8"), &LOCALES), Locale::En); // no match
/// assert_eq!(negotiate(None, &LOCALES), Locale::En);
/// ```
pub fn negotiate(header: Option<&str>, locales: &[Locale]) -> Locale {
	let Some(header) = header else {
		return DEFAULT_LOCALE;
	};
	for tag in ranked_tags(header) {
		// "ru-RU" and "ru" both match the "ru" catalogue.
		let base = tag.split('-').next().unwrap_or("");
		if let Some(hit) = locales.iter().find(|l| l.code() == tag || l.code() == base) {
			return *hit;
		}
		// "*" means "anything", for which the default is as good an answer as any.
		if tag == "*" {
			return DEFAULT_LOCALE;
		}
	}
	DEFAULT_LOCALE
}

/// Every locale's URL for one page — the shape an `hreflang` cluster wants.
///
/// ```
/// use ev_lib::i18n::{LOCALES, locale_alternates};
/// let alts = locale_alternates("/team", &LOCALES);
/// assert_eq!(alts[0].1, "/team");
/// assert_eq!(alts[1].1, "/ru/team");
/// ```
pub fn locale_alternates(path: &str, locales: &[Locale]) -> Vec<(Locale, String)> {
	locales.iter().map(|&l| (l, locale_path(l, path))).collect()
}
/// The inverse of [`locale_path`]: split a request path into its locale and the
/// locale-free path beneath it. An absent or unrecognised prefix reads as
/// [`DEFAULT_LOCALE`], so this never fails on arbitrary input.
///
/// ```
/// use ev_lib::i18n::{Locale, split_locale_path};
/// assert_eq!(split_locale_path("/ru/team"), (Locale::Ru, "/team".to_owned()));
/// assert_eq!(split_locale_path("/team"), (Locale::En, "/team".to_owned()));
/// assert_eq!(split_locale_path("/ru"), (Locale::Ru, "/".to_owned()));
/// ```
pub fn split_locale_path(pathname: &str) -> (Locale, String) {
	let clean = if pathname.starts_with('/') { pathname.to_owned() } else { format!("/{pathname}") };
	let after = &clean[1..];
	let (head, rest) = match after.find('/') {
		Some(idx) => (&after[..idx], &after[idx..]),
		None => (after, ""),
	};
	match Locale::parse(head) {
		Some(locale) if locale != DEFAULT_LOCALE => (locale, if rest.is_empty() { "/".to_owned() } else { rest.to_owned() }),
		_ => (DEFAULT_LOCALE, clean),
	}
}
/// The path `locale` serves `path` at.
///
/// ```
/// use ev_lib::i18n::{Locale, locale_path};
/// assert_eq!(locale_path(Locale::En, "/team"), "/team");
/// assert_eq!(locale_path(Locale::Ru, "/team"), "/ru/team");
/// assert_eq!(locale_path(Locale::Ru, "/"), "/ru");
/// ```
pub fn locale_path(locale: Locale, path: &str) -> String {
	let clean = if path.starts_with('/') { path.to_owned() } else { format!("/{path}") };
	if locale == DEFAULT_LOCALE {
		return clean;
	}
	// "/" would otherwise yield "/ru/", and a trailing slash is a distinct URL to
	// a crawler — one canonical shape per page, so strip it.
	if clean == "/" { format!("/{locale}") } else { format!("/{locale}{clean}") }
}
/// The error [`Locale::from_str`] returns for a tag EV does not publish.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnknownLocale(pub String);
/// One of the five locales EV publishes.
///
/// Note `Vi` — Vietnamese — is the ISO 639-1 *language* code. `vn` is the ISO
/// 3166 *country* code for Vietnam and is not a valid `hreflang` / `lang` value;
/// Google silently discards invalid values, so the distinction is load-bearing.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Locale {
	#[default]
	En,
	Ru,
	Vi,
	Fr,
	De,
}
/// One `t!` call site, as the linker collected it.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Source {
	pub ctx: Option<&'static str>,
	pub en: &'static str,
}
/// The id of every [`t!`] site linked into this binary — what each locale's catalogue must cover.
#[cfg(not(target_arch = "wasm32"))]
pub fn catalogue() -> std::collections::BTreeSet<String> {
	inventory::iter::<Source>.into_iter().map(|s| message_id(s.ctx, s.en)).collect()
}
/// The language tags of an `Accept-Language` header, lowercased, best first.
/// Shared by [`negotiate`] and [`LocaleRegistry::negotiate`] so the two cannot
/// rank one header differently.
fn ranked_tags(header: &str) -> Vec<String> {
	let mut ranked: Vec<(String, f64)> = header
		.split(',')
		.filter_map(|part| {
			let mut params = part.trim().split(';');
			let tag = params.next().unwrap_or("").trim().to_ascii_lowercase();
			let quality = params
				.map(str::trim)
				.find_map(|p| p.strip_prefix("q="))
				// A malformed or non-finite q= (`inf`, `NaN` — Rust parses both) is
				// dropped rather than outranking every real preference.
				.map_or(1.0, |q| q.parse::<f64>().ok().filter(|q| q.is_finite()).unwrap_or(0.0));
			// q=0 is an explicit refusal of that language, not a weak preference.
			(!tag.is_empty() && quality > 0.0).then_some((tag, quality))
		})
		.collect();

	// Stable sort: equal q-values keep the client's stated order, which is the
	// tie-break the header itself intends.
	ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
	ranked.into_iter().map(|(tag, _)| tag).collect()
}

#[cfg(not(target_arch = "wasm32"))]
inventory::collect!(Source);
