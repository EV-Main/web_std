//! EV's translation policy, enforced in code rather than in review.
//!
//! **1.1 — English is canonical.** It lives only at the call sites, and a message's identity is its
//! English ([`message_id`](super::message_id)). Every other locale is a derivation: per locale, a
//! generated catalogue (`<locale>.auto.json`) and the hand-written overrides laid over it
//! (`<locale>.json`), both keyed by that identity.
//!
//! **1.2 — A translation that no longer matches its English source is not used.** Because the key
//! *is* the English, an edited sentence leaves its old translation keyed by text nothing renders:
//! an orphan, refused, while the new English is generated afresh.
//!
//! **1.3 — Compiled content with no translation for the current locale is
//! hidden, not silently served in English.** See [`available_in`].
//!
//! Nothing here compares *meaning* across languages. What is mechanically checkable is
//! **provenance** (the key) and **structure**: the placeholders, their argument types, and the
//! plural categories a locale requires — a Russian plural with only `one`/`other` is provably wrong.

use std::collections::{BTreeMap, BTreeSet};

use super::{CTX_SEPARATOR, DEFAULT_LOCALE, Locale, Messages};

/// Why a translation was refused.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "ts_gen", derive(strum::EnumIter))]
pub enum RejectionReason {
	/// An override keyed by English the code no longer renders — its English changed or went away.
	OrphanOverride,
	/// A generated entry keyed by English the code no longer renders.
	OrphanAuto,
	/// The translation interpolates a different set of placeholders.
	PlaceholderMismatch,
	/// An argument is a plural/select in one language and not the other.
	ArgumentTypeMismatch,
	/// A plural is missing a category this locale requires (ru needs few/many).
	PluralCategoryMissing,
	/// Blank translation.
	Empty,
}

impl RejectionReason {
	/// The kebab-case name; `ev_lib_gen` writes the TypeScript union from it.
	pub fn as_str(self) -> &'static str {
		match self {
			Self::OrphanOverride => "orphan-override",
			Self::OrphanAuto => "orphan-auto",
			Self::PlaceholderMismatch => "placeholder-mismatch",
			Self::ArgumentTypeMismatch => "argument-type-mismatch",
			Self::PluralCategoryMissing => "plural-category-missing",
			Self::Empty => "empty",
		}
	}
}

impl std::fmt::Display for RejectionReason {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

/// One refusal, with enough detail to fix it without opening the catalogue.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rejection {
	pub key: String,
	pub reason: RejectionReason,
	pub detail: String,
}

/// The outcome of applying the policy to one locale.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedCatalogue {
	pub locale: Locale,
	/// Ready for [`Translator`](super::Translator): every accepted translation.
	pub messages: Messages,
	pub rejected: Vec<Rejection>,
	/// Ids the code renders that this locale has no accepted translation for.
	pub missing: Vec<String>,
	/// Share of ids served in this locale, 0–1.
	pub coverage: f64,
}

/// Apply rules 1.1 and 1.2 to one locale: an override wins over the generated entry, a refused
/// one gives way to it, and an id with neither accepted is missing.
///
/// ```
/// use ev_lib::i18n::{Locale, Messages};
/// use ev_lib::i18n::policy::resolve_catalogue;
///
/// let source = ["Coastal Vietnam, today".to_owned()].into();
/// let auto = Messages::from([("Coastal Vietnam, today".into(), "Прибрежный Вьетнам сегодня".into())]);
/// // Written for English that has since changed — keyed by text nothing renders.
/// let overrides = Messages::from([("Coastal Vietnam".into(), "Прибрежный Вьетнам".into())]);
///
/// let resolved = resolve_catalogue(Locale::Ru, &source, &auto, &overrides);
/// assert_eq!(resolved.messages["Coastal Vietnam, today"], "Прибрежный Вьетнам сегодня");
/// assert_eq!(resolved.rejected.len(), 1);
/// ```
pub fn resolve_catalogue(locale: Locale, source: &BTreeSet<String>, auto: &Messages, overrides: &Messages) -> ResolvedCatalogue {
	if locale == DEFAULT_LOCALE {
		return ResolvedCatalogue {
			locale,
			messages: source.iter().map(|id| (id.clone(), english(id).to_owned())).collect(),
			rejected: Vec::new(),
			missing: Vec::new(),
			coverage: 1.0,
		};
	}

	let mut messages = Messages::new();
	let mut rejected = Vec::new();
	let mut missing = Vec::new();

	for (catalogue, reason) in [(overrides, RejectionReason::OrphanOverride), (auto, RejectionReason::OrphanAuto)] {
		for key in catalogue.keys().filter(|key| !source.contains(*key)) {
			rejected.push(Rejection {
				key: key.clone(),
				reason,
				detail: format!("the code no longer renders {:?}", english(key)),
			});
		}
	}

	for id in source {
		let en = english(id);
		let mut served = None;
		for (catalogue, from) in [(overrides, "override"), (auto, "generated")] {
			let Some(t) = catalogue.get(id) else { continue };
			match check(t, en, locale) {
				Some((reason, detail)) => rejected.push(Rejection {
					key: id.clone(),
					reason,
					detail: format!("{from}: {detail}"),
				}),
				None => {
					served = Some(t);
					break;
				}
			}
		}
		match served {
			Some(t) => {
				messages.insert(id.clone(), t.clone());
			}
			None => missing.push(id.clone()),
		}
	}

	let coverage = if source.is_empty() { 1.0 } else { messages.len() as f64 / source.len() as f64 };
	ResolvedCatalogue {
		locale,
		messages,
		rejected,
		missing,
		coverage,
	}
}

/// Render resolved catalogues as a report for a CI check. `floor` is the minimum acceptable
/// coverage, 0–1.
pub fn audit(resolved: &[ResolvedCatalogue], floor: f64) -> (bool, String) {
	let mut lines = Vec::new();
	let mut ok = true;

	for cat in resolved {
		let pct = (cat.coverage * 100.0).round() as i64;
		let healthy = cat.rejected.is_empty() && cat.coverage >= floor;
		if !healthy {
			ok = false;
		}
		lines.push(format!("{} {}  {pct}% coverage", if healthy { "ok  " } else { "FAIL" }, cat.locale));

		for r in &cat.rejected {
			lines.push(format!("       {}  [{}] {}", r.key, r.reason, r.detail));
		}
		// Missing keys are listed but capped: a locale that has translated nothing
		// yet would otherwise bury the drift that actually needs fixing.
		if !cat.missing.is_empty() {
			let shown: Vec<&str> = cat.missing.iter().take(10).map(String::as_str).collect();
			lines.push(format!("       untranslated ({}): {}", cat.missing.len(), shown.join(", ")));
			if cat.missing.len() > shown.len() {
				lines.push(format!("       …and {} more", cat.missing.len() - shown.len()));
			}
		}
	}

	(ok, lines.join("\n"))
}
/// What to do with a content item that has no translation for the current
/// locale.
///
/// [`Hide`](MissingContentPolicy::Hide) is the policy for *compiled* content —
/// publications, the whitepaper, anything built once and surfaced everywhere. A
/// Russian reader given an English essay under Russian chrome learns that the
/// locale is a veneer.
///
/// [`Fallback`](MissingContentPolicy::Fallback) exists because the rule is not
/// universally right, and pretending otherwise would be the bug. A vacancy is
/// the clear case: hiding an open role from a Russian speaker who reads English
/// fine costs a candidate, and loses more than the inconsistency costs. Choose
/// per collection, deliberately.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MissingContentPolicy {
	#[default]
	Hide,
	Fallback,
}
/// Apply rule 1.3 to a content collection.
///
/// ```
/// use ev_lib::i18n::Locale;
/// use ev_lib::i18n::policy::{MissingContentPolicy, available_in};
///
/// struct Lot { name: &'static str, locales: Vec<Locale> }
/// let lots = vec![
///     Lot { name: "A1", locales: vec![Locale::En, Locale::Ru] },
///     Lot { name: "B2", locales: vec![Locale::En] },
/// ];
///
/// let shown = available_in(Locale::Ru, &lots, |l| l.locales.as_slice(), MissingContentPolicy::Hide);
/// assert_eq!(shown.len(), 1);
/// assert_eq!(shown[0].name, "A1");
/// ```
pub fn available_in<T, F>(locale: Locale, items: &[T], locales_of: F, policy: MissingContentPolicy) -> Vec<&T>
where
	F: Fn(&T) -> &[Locale], {
	if locale == DEFAULT_LOCALE || policy == MissingContentPolicy::Fallback {
		return items.iter().collect();
	}
	items.iter().filter(|item| locales_of(item).contains(&locale)).collect()
}
/// The structural half of rule 1.2 for a single translation. `None` means accepted.
fn check(t: &str, en: &str, locale: Locale) -> Option<(RejectionReason, String)> {
	if t.trim().is_empty() {
		return Some((RejectionReason::Empty, "translation is blank".to_owned()));
	}

	let source_args = scan_arguments(en);
	let target_args = scan_arguments(t);

	for (name, kind) in &source_args {
		let Some(mirrored) = target_args.get(name) else {
			return Some((RejectionReason::PlaceholderMismatch, format!("source interpolates {{{name}}}, translation does not")));
		};
		if mirrored.arg_type != kind.arg_type {
			return Some((
				RejectionReason::ArgumentTypeMismatch,
				format!("{{{name}}} is a {} in {DEFAULT_LOCALE} and a {} here", kind.arg_type, mirrored.arg_type),
			));
		}
		if kind.arg_type == ArgType::Plural {
			// The arithmetic half of "semantically equal". English has two plural
			// categories; Russian has four. A translation that only mirrors
			// English's branches is missing cases real numbers will hit.
			//
			// `other` is NOT accepted as a wildcard here, even though the formatter
			// falls back to it at runtime. That fallback is what stops a page
			// breaking; it is not evidence the translation is right. A Russian
			// `one`/`other` pair renders "5 участка" for five — grammatical
			// nonsense — and the runtime cannot tell, because it got a branch. The
			// whole point of a build-time check is to catch what degrades silently.
			// A locale that genuinely needs one branch (Vietnamese) declares only
			// `other`, so it passes on the same rule rather than an exemption.
			let absent: Vec<&str> = locale.plural_categories().iter().map(|c| c.as_str()).filter(|c| !mirrored.branches.contains(*c)).collect();
			if !absent.is_empty() {
				return Some((RejectionReason::PluralCategoryMissing, format!("{{{name}}} needs {} in {locale}", absent.join(", "))));
			}
		}
	}

	for name in target_args.keys() {
		if !source_args.contains_key(name) {
			return Some((
				RejectionReason::PlaceholderMismatch,
				format!("translation interpolates {{{name}}}, which the source does not provide"),
			));
		}
	}

	None
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ArgType {
	Value,
	Plural,
	Select,
}

impl std::fmt::Display for ArgType {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(match self {
			Self::Value => "value",
			Self::Plural => "plural",
			Self::Select => "select",
		})
	}
}

#[derive(Clone, Debug)]
struct ArgumentShape {
	arg_type: ArgType,
	branches: BTreeSet<String>,
}

/// Extract each argument's name, type, and (for plural/select) branch keys.
///
/// Deliberately independent of the formatter: this needs only the shape of the
/// arguments, never their rendered output, and keeping the two separate means
/// the policy carries no formatting behaviour it would then have to keep in
/// sync.
fn scan_arguments(pattern: &str) -> BTreeMap<String, ArgumentShape> {
	let mut found = BTreeMap::new();
	walk(&pattern.chars().collect::<Vec<char>>(), &mut found);
	found
}

fn walk(text: &[char], found: &mut BTreeMap<String, ArgumentShape>) {
	let mut i = 0;
	while i < text.len() {
		let ch = text[i];

		// Mirror the formatter's ICU 4.8 quoting so an escaped '{' is not read as
		// an argument — otherwise "it's '{not}' a placeholder" trips the checker.
		if ch == '\'' {
			let next = text.get(i + 1).copied();
			if next == Some('\'') {
				i += 2;
				continue;
			}
			if matches!(next, Some('{') | Some('}') | Some('#')) {
				i += 2;
				while i < text.len() && text[i] != '\'' {
					i += 1;
				}
				i += 1;
				continue;
			}
			i += 1;
			continue;
		}

		if ch != '{' {
			i += 1;
			continue;
		}

		let Some(end) = closing(text, i) else { return };
		let inner = &text[i + 1..end];
		i = end + 1;

		let Some(first_comma) = top_level(inner, ',') else {
			let name: String = inner.iter().collect::<String>().trim().to_owned();
			if !name.is_empty() {
				found.entry(name).or_insert(ArgumentShape {
					arg_type: ArgType::Value,
					branches: BTreeSet::new(),
				});
			}
			continue;
		};

		let name: String = inner[..first_comma].iter().collect::<String>().trim().to_owned();
		let rest = &inner[first_comma + 1..];
		let second_comma = top_level(rest, ',');
		let declared: String = match second_comma {
			Some(idx) => rest[..idx].iter().collect::<String>(),
			None => rest.iter().collect::<String>(),
		}
		.trim()
		.to_owned();
		let body: &[char] = match second_comma {
			Some(idx) => &rest[idx + 1..],
			None => &[],
		};
		let arg_type = match declared.as_str() {
			"plural" => ArgType::Plural,
			"select" => ArgType::Select,
			_ => ArgType::Value,
		};

		let mut branches = BTreeSet::new();
		if arg_type != ArgType::Value {
			for (branch_key, branch_body) in branches_of(body) {
				branches.insert(branch_key);
				walk(&branch_body, found);
			}
		}
		if !name.is_empty() {
			found.insert(name, ArgumentShape { arg_type, branches });
		}
	}
}

fn closing(source: &[char], start: usize) -> Option<usize> {
	let mut depth = 0usize;
	for (offset, ch) in source[start..].iter().enumerate() {
		match ch {
			'{' => depth += 1,
			'}' => {
				depth -= 1;
				if depth == 0 {
					return Some(start + offset);
				}
			}
			_ => {}
		}
	}
	None
}

fn top_level(source: &[char], sep: char) -> Option<usize> {
	let mut depth = 0i32;
	for (i, &ch) in source.iter().enumerate() {
		match ch {
			'{' => depth += 1,
			'}' => depth -= 1,
			c if c == sep && depth == 0 => return Some(i),
			_ => {}
		}
	}
	None
}

fn branches_of(body: &[char]) -> Vec<(String, Vec<char>)> {
	let mut out = Vec::new();
	let mut i = 0;
	while i < body.len() {
		while i < body.len() && body[i].is_whitespace() {
			i += 1;
		}
		let key_start = i;
		while i < body.len() && !body[i].is_whitespace() && body[i] != '{' {
			i += 1;
		}
		let key: String = body[key_start..i].iter().collect();
		while i < body.len() && body[i].is_whitespace() {
			i += 1;
		}
		if body.get(i) != Some(&'{') {
			break;
		}
		let Some(end) = closing(body, i) else { break };
		if !key.is_empty() {
			out.push((key, body[i + 1..end].to_vec()));
		}
		i = end + 1;
	}
	out
}

/// The English of a message id.
fn english(id: &str) -> &str {
	id.split_once(CTX_SEPARATOR).map_or(id, |(_, en)| en)
}
