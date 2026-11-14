//! Scoped keybinds: a root the page claims globally, scopes a root chord opens, a which-key hint for
//! the open one and every leaf for a help. See docs/ARCHITECTURE.md, "The `keymap` library".

use std::{collections::HashSet, fmt::Display};

/// One keydown to match. `key` is what [`KeyInput`] normalizes to: a printable ASCII char, whose
/// case carries Shift (`"u"`, `"U"`, `"?"`), or a named key (`"Backspace"`). Shift is never a flag.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Chord {
	pub key: &'static str,
	pub ctrl: bool = false,
	pub alt: bool = false,
	pub meta: bool = false,
}

/// What fires a binding, per [`Platform`]: macOS takes Cmd where others take Ctrl.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Trigger {
	pub other: Chord,
	pub mac: Chord,
}

impl Trigger {
	/// As its keycaps read: `Ctrl+Shift+k` elsewhere, `⇧⌘k` on macOS; a letter lowercase, Shift spelled out.
	pub fn render(&self, platform: Platform) -> String {
		render(
			&match platform {
				Platform::Mac => self.mac,
				Platform::Other => self.other,
			},
			platform,
		)
	}
}

impl From<Chord> for Trigger {
	fn from(c: Chord) -> Self {
		Self { other: c, mac: c }
	}
}

#[derive(Clone, Debug, PartialEq)]
pub struct Binding<C> {
	pub on: Trigger,
	pub node: Node<C>,
}

/// A leaf is labelled by its command's `Display`; a scope by its own label. A leaf's `id` names it
/// across languages and to whatever runs it without its keys (an agent), unique within one keymap.
#[derive(Clone, Debug, PartialEq)]
pub enum Node<C> {
	Run { id: String, command: C },
	Scope { label: String, children: Vec<Binding<C>> },
}

/// Every chord the page claims without a scope open. A leader is a root [`Node::Scope`].
#[derive(Clone, Debug, PartialEq)]
pub struct Keymap<C> {
	pub root: Vec<Binding<C>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "ts_gen", derive(strum::EnumIter, strum::IntoStaticStr), strum(serialize_all = "lowercase"))]
pub enum Platform {
	Mac,
	Other,
}

/// `navigator.platform`. iPadOS reports `MacIntel`.
impl From<&str> for Platform {
	fn from(navigator_platform: &str) -> Self {
		if ["Mac", "iPhone", "iPad", "iPod"].iter().any(|p| navigator_platform.contains(p)) {
			Self::Mac
		} else {
			Self::Other
		}
	}
}

#[cfg(all(target_arch = "wasm32", any(feature = "wasm", feature = "uikit_leptos")))]
impl Platform {
	pub fn current() -> Self {
		let navigator = web_sys::window().expect("keybinds run in a browser window").navigator();
		Self::from(navigator.platform().expect("navigator.platform never throws").as_str())
	}
}

/// A raw keydown, before normalization: the DOM `KeyboardEvent` fields of the same names.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyInput {
	pub key: String,
	pub code: String,
	pub ctrl: bool,
	pub alt: bool,
	pub meta: bool,
	pub shift: bool,
	pub repeat: bool,
	/// An IME composition is under way: the key belongs to it.
	pub composing: bool,
	/// The event's innermost target takes text, so a root leaf leaves it its typing and undo.
	/// `None` where the renderer has no DOM event path to tell (non-web Dioxus).
	pub editable: Option<bool>,
}

#[cfg(all(target_arch = "wasm32", any(feature = "wasm", feature = "uikit_leptos")))]
impl From<&web_sys::KeyboardEvent> for KeyInput {
	fn from(e: &web_sys::KeyboardEvent) -> Self {
		use web_sys::wasm_bindgen::JsCast;
		// `composed_path()[0]`, not `target()`: on `window`, an `<input>` inside a shadow root reports
		// as its host element.
		let editable =
			e.composed_path().get(0).dyn_into::<web_sys::Element>().is_ok_and(|el| {
				matches!(el.tag_name().as_str(), "INPUT" | "TEXTAREA" | "SELECT") || el.dyn_ref::<web_sys::HtmlElement>().is_some_and(web_sys::HtmlElement::is_content_editable)
			});
		Self {
			key: e.key(),
			code: e.code(),
			ctrl: e.ctrl_key(),
			alt: e.alt_key(),
			meta: e.meta_key(),
			shift: e.shift_key(),
			repeat: e.repeat(),
			composing: e.is_composing(),
			editable: Some(editable),
		}
	}
}

const MODIFIERS: [&str; 8] = ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Fn"];

/// Whether a `key` names one a binding could mean: not a modifier, nor a key the layout couldn't say.
fn is_key(key: &str) -> bool {
	let mut chars = key.chars();
	match (chars.next(), chars.next()) {
		(Some(c), None) => c.is_ascii_graphic() || c == ' ',
		(Some(_), Some(_)) => key.chars().all(|c| c.is_ascii_alphanumeric()) && !MODIFIERS.contains(&key) && !["Dead", "Unidentified", "Process"].contains(&key),
		(None, _) => false,
	}
}

impl KeyInput {
	/// The [`Chord::key`] this keydown is, or `None` for one no binding can mean (a lone modifier).
	/// The printable ASCII `key` the layout produced; else a named key; else the Latin label of the
	/// physical key (`KeyS`), so ЙЦУКЕН and macOS Option chords reach the letter printed on the key.
	/// Letter case comes from Shift alone, so CapsLock is ignored.
	pub fn normalized(&self) -> Option<String> {
		let case = |c: char| if self.shift { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() };
		if is_key(&self.key) {
			let mut chars = self.key.chars();
			return Some(match (chars.next(), chars.next()) {
				(Some(c), None) => case(c).to_string(),
				_ => self.key.clone(),
			});
		}
		if MODIFIERS.contains(&self.key.as_str()) {
			return None;
		}
		let label = self.code.strip_prefix("Key").or_else(|| self.code.strip_prefix("Digit"))?;
		let mut chars = label.chars();
		match (chars.next(), chars.next()) {
			(Some(c), None) if c.is_ascii_alphanumeric() => Some(case(c).to_string()),
			_ => None,
		}
	}
}

/// The which-key popup for the scope a chord has opened.
#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "ts_gen", derive(serde::Serialize, ts_rs::TS))]
pub struct Hint {
	pub prefix: String,
	pub rows: Vec<HintRow>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "ts_gen", derive(serde::Serialize, ts_rs::TS))]
pub struct HintRow {
	pub chord: String,
	pub label: String,
	/// Pressing it opens another level rather than running something.
	pub scope: bool,
}

/// One bound leaf, for the help.
#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(feature = "ts_gen", derive(serde::Serialize, ts_rs::TS))]
pub struct HelpRow {
	pub id: String,
	pub sequence: String,
	pub label: String,
}

/// Where a keydown went.
#[derive(Clone, Debug, PartialEq)]
pub enum Step<C> {
	/// Not ours: the key goes on to the page. `cancelled` when it dropped an open scope.
	Pass { cancelled: bool },
	/// A scope opened, or re-opened from the root.
	Opened,
	/// Esc closed the open scope.
	Closed,
	/// A held key reached a leaf: kept from the browser, and nothing runs again.
	Held,
	/// The leaf reached, and the sequence that reached it.
	Run { command: C, sequence: String },
}

/// A [`Keymap`] resolved for one platform, and the path a chord has opened into it.
pub struct Trie<C> {
	root: Level<C>,
	platform: Platform,
	pending: Vec<usize>,
}

type Level<C> = Vec<(Chord, Item<C>)>;

enum Item<C> {
	Run { label: String, id: String, command: C },
	Scope(String, Level<C>),
}

impl<C: Clone + Display> Trie<C> {
	/// A command `available` rejects is unbound; a scope left with nothing in it, too.
	pub fn new(k: &Keymap<C>, platform: Platform, available: impl Fn(&C) -> bool) -> Self {
		fn ids<'a, C>(bs: &'a [Binding<C>], seen: &mut HashSet<&'a str>) {
			for b in bs {
				match &b.node {
					Node::Run { id, .. } => assert!(seen.insert(id), "{id:?} names two leaves"),
					Node::Scope { children, .. } => ids(children, seen),
				}
			}
		}
		ids(&k.root, &mut HashSet::new());
		let pick = |t: &Trigger| match platform {
			Platform::Mac => t.mac,
			Platform::Other => t.other,
		};
		fn level<C: Clone + Display>(bs: &[Binding<C>], pick: &dyn Fn(&Trigger) -> Chord, available: &dyn Fn(&C) -> bool) -> Level<C> {
			for (i, b) in bs.iter().enumerate() {
				let c = pick(&b.on);
				assert!(is_key(c.key), "{c:?} names no key a keydown normalizes to");
				assert!(!bs[..i].iter().any(|o| pick(&o.on) == c), "{c:?} is bound twice in one scope");
			}
			bs.iter()
				.filter_map(|b| {
					let item = match &b.node {
						Node::Run { command, .. } if !available(command) => return None,
						Node::Run { id, command } => Item::Run {
							label: command.to_string(),
							id: id.clone(),
							command: command.clone(),
						},
						Node::Scope { label, children } => match level(children, pick, available) {
							l if l.is_empty() => return None,
							l => Item::Scope(label.clone(), l),
						},
					};
					Some((pick(&b.on), item))
				})
				.collect()
		}
		Self {
			root: level(&k.root, &pick, &available),
			platform,
			pending: Vec::new(),
		}
	}

	fn at(&self, path: &[usize]) -> &Level<C> {
		path.iter().fold(&self.root, |l, &i| match &l[i].1 {
			Item::Scope(_, children) => children,
			Item::Run { .. } => unreachable!("a pending path only ever descends into scopes"),
		})
	}

	/// One keydown. A miss drops the open scope, a lone modifier doesn't; a root scope's chord
	/// pressed inside another (a key-repeating leader) restarts at that scope instead. A modified
	/// leader (a bare-key one with Alt) and an open scope's keys act from an editable; a root leaf or an unmodified root chord
	/// leaves it its typing and undo.
	pub fn key(&mut self, k: &KeyInput) -> Step<C> {
		let open = !self.pending.is_empty();
		if k.composing {
			self.pending.clear();
			return Step::Pass { cancelled: open };
		}
		if MODIFIERS.contains(&k.key.as_str()) {
			return Step::Pass { cancelled: false };
		}
		let Some(key) = k.normalized() else {
			self.pending.clear();
			return Step::Pass { cancelled: open };
		};
		if open && key == "Escape" {
			self.pending.clear();
			return Step::Closed;
		}
		let hit = |l: &Level<C>| l.iter().position(|(c, _)| c.key == key && c.ctrl == k.ctrl && c.alt == k.alt && c.meta == k.meta);
		// A bare-key root scope is reached with Alt too: in a field the bare key types.
		let alted = |j: Option<usize>| match j {
			None if k.alt && !k.ctrl && !k.meta => self
				.root
				.iter()
				.position(|(c, item)| matches!(item, Item::Scope(..)) && c.key == key && !c.ctrl && !c.alt && !c.meta),
			j => j,
		};
		let here = hit(self.at(&self.pending));
		let i = match if self.pending.is_empty() { alted(here) } else { here } {
			Some(i) => i,
			None => match alted(hit(&self.root)) {
				Some(i) if open && matches!(self.root[i].1, Item::Scope(..)) => {
					self.pending.clear();
					i
				}
				_ => {
					self.pending.clear();
					return Step::Pass { cancelled: open };
				}
			},
		};
		// At root a field keeps its typing (an unmodified chord, a leader's too) and its undo (a leaf).
		let fields = self.pending.is_empty() && (matches!(self.root[i].1, Item::Run { .. }) || !(k.ctrl || k.alt || k.meta));
		if fields && k.editable.expect("a page keymap listens on a browser window, whose keydowns know their target") {
			return Step::Pass { cancelled: open };
		}
		self.pending.push(i);
		let sequence = self.sequence(&self.pending);
		let command = match &self.at(&self.pending[..self.pending.len() - 1])[i].1 {
			Item::Scope(..) => return Step::Opened,
			Item::Run { command, .. } => command.clone(),
		};
		self.pending.clear();
		if k.repeat { Step::Held } else { Step::Run { command, sequence } }
	}

	/// Drop the open scope (the window lost focus, a press moved on). Whether one was open.
	pub fn cancel(&mut self) -> bool {
		let open = !self.pending.is_empty();
		self.pending.clear();
		open
	}

	fn sequence(&self, path: &[usize]) -> String {
		let mut out = Vec::new();
		let mut l = &self.root;
		for &i in path {
			out.push(render(&l[i].0, self.platform));
			if let Item::Scope(_, children) = &l[i].1 {
				l = children;
			}
		}
		out.join(" ")
	}

	/// The open scope's hint; `None` while none is open.
	pub fn hint(&self) -> Option<Hint> {
		if self.pending.is_empty() {
			return None;
		}
		let rows = self
			.at(&self.pending)
			.iter()
			.map(|(c, item)| HintRow {
				chord: render(c, self.platform),
				label: label(item).to_owned(),
				scope: matches!(item, Item::Scope(..)),
			})
			.collect();
		Some(Hint {
			prefix: self.sequence(&self.pending),
			rows,
		})
	}

	/// Every bound leaf, depth-first.
	pub fn help(&self) -> Vec<HelpRow> {
		fn walk<C>(l: &Level<C>, prefix: &str, platform: Platform, out: &mut Vec<HelpRow>) {
			for (c, item) in l {
				let chord = render(c, platform);
				let sequence = if prefix.is_empty() { chord } else { format!("{prefix} {chord}") };
				match item {
					Item::Run { label, id, .. } => out.push(HelpRow {
						id: id.clone(),
						sequence,
						label: label.clone(),
					}),
					Item::Scope(_, children) => walk(children, &sequence, platform, out),
				}
			}
		}
		let mut out = Vec::new();
		walk(&self.root, "", self.platform, &mut out);
		out
	}

	/// What the bound leaf `id` runs; `None` while it is unbound.
	pub fn command(&self, id: &str) -> Option<&C> {
		fn find<'a, C>(l: &'a Level<C>, id: &str) -> Option<&'a C> {
			l.iter().find_map(|(_, item)| match item {
				Item::Run { id: i, command, .. } => (i == id).then_some(command),
				Item::Scope(_, children) => find(children, id),
			})
		}
		find(&self.root, id)
	}
}

fn label<C>(item: &Item<C>) -> &str {
	match item {
		Item::Run { label, .. } | Item::Scope(label, _) => label,
	}
}

fn render(c: &Chord, platform: Platform) -> String {
	let mut chars = c.key.chars();
	let (shift, key) = match (chars.next(), chars.next()) {
		(Some(ch), None) if ch.is_ascii_alphabetic() => (ch.is_ascii_uppercase(), ch.to_ascii_lowercase().to_string()),
		(Some(' '), None) => (false, "Space".to_owned()),
		_ => (false, c.key.to_owned()),
	};
	let mods = [(c.ctrl, "Ctrl+", "⌃"), (c.alt, "Alt+", "⌥"), (shift, "Shift+", "⇧"), (c.meta, "Meta+", "⌘")];
	let mut s: String = mods
		.iter()
		.filter(|(on, ..)| *on)
		.map(|(_, other, mac)| match platform {
			Platform::Mac => *mac,
			Platform::Other => *other,
		})
		.collect();
	s.push_str(&key);
	s
}
