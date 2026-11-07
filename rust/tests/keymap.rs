//! `tests/fixtures/keymap/keymap.json`, which `ts/keymap` reads too.
#![cfg(feature = "keymap")]
#![feature(default_field_values)]

use ev_lib::keymap::{Binding, Chord, HelpRow, Hint, HintRow, KeyInput, Keymap, Node, Platform, Step, Trie, Trigger};
use serde_json::Value;

fn fixture() -> Value {
	let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/keymap/keymap.json");
	serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture is committed")).expect("the fixture is JSON")
}

fn flag(v: &Value, name: &str) -> bool {
	v.get(name).map_or(false, |f| f.as_bool().expect("a flag is a bool"))
}

fn text(v: &Value) -> String {
	v.as_str().expect("a string").to_owned()
}

fn chord(v: &Value) -> Chord {
	Chord {
		key: String::leak(text(&v["key"])),
		ctrl: flag(v, "ctrl"),
		alt: flag(v, "alt"),
		meta: flag(v, "meta"),
	}
}

fn bindings(v: &Value) -> Vec<Binding<String>> {
	v.as_array()
		.expect("bindings are an array")
		.iter()
		.map(|b| Binding {
			on: match b["on"].get("other") {
				Some(other) => Trigger {
					other: chord(other),
					mac: chord(&b["on"]["mac"]),
				},
				None => chord(&b["on"]).into(),
			},
			node: match b.get("run") {
				Some(run) => Node::Run(text(run)),
				None => Node::Scope {
					label: text(&b["label"]),
					children: bindings(&b["children"]),
				},
			},
		})
		.collect()
}

fn platform(v: &Value) -> Platform {
	match v.get("platform").map(text).as_deref() {
		None | Some("other") => Platform::Other,
		Some("mac") => Platform::Mac,
		Some(p) => panic!("no platform {p}"),
	}
}

fn trie(f: &Value, case: &Value) -> Trie<String> {
	let unavailable: Vec<String> = case.get("unavailable").map_or(Vec::new(), |u| u.as_array().expect("an array").iter().map(text).collect());
	Trie::new(&Keymap { root: bindings(&f["keymap"]) }, platform(case), |c| !unavailable.contains(c))
}

fn input(v: &Value) -> KeyInput {
	if v.is_object() {
		return KeyInput {
			key: text(&v["key"]),
			code: text(&v["code"]),
			ctrl: flag(v, "ctrl"),
			alt: flag(v, "alt"),
			meta: flag(v, "meta"),
			shift: flag(v, "shift"),
			repeat: flag(v, "repeat"),
			composing: flag(v, "composing"),
			editable: flag(v, "editable"),
		};
	}
	let tok = v.as_str().expect("a keydown is a token or an object");
	let (editable, tok) = tok.strip_prefix('!').map_or((false, tok), |t| (true, t));
	let mut parts: Vec<&str> = tok.split('+').collect();
	let key = parts.pop().expect("split yields at least one part");
	let has = |m: &str| parts.contains(&m);
	let one = key.chars().count() == 1;
	let c = key.chars().next().expect("a key is non-empty");
	KeyInput {
		key: key.to_owned(),
		code: match c {
			c if one && c.is_ascii_alphabetic() => format!("Key{}", c.to_ascii_uppercase()),
			c if one && c.is_ascii_digit() => format!("Digit{c}"),
			_ if one => String::new(),
			_ => key.to_owned(),
		},
		ctrl: has("Ctrl"),
		alt: has("Alt"),
		meta: has("Meta"),
		shift: has("Shift") || key == "Shift" || (one && c.is_ascii_uppercase()),
		repeat: false,
		composing: false,
		editable,
	}
}

fn spell(s: Step<String>) -> String {
	match s {
		Step::Pass { cancelled: false } => "pass".into(),
		Step::Pass { cancelled: true } => "cancelled".into(),
		Step::Opened => "opened".into(),
		Step::Closed => "closed".into(),
		Step::Held => "held".into(),
		Step::Run { command, sequence } => format!("run {command}: {sequence}"),
	}
}

fn hint(v: &Value) -> Option<Hint> {
	(!v.is_null()).then(|| Hint {
		prefix: text(&v["prefix"]),
		rows: v["rows"]
			.as_array()
			.expect("rows are an array")
			.iter()
			.map(|r| HintRow {
				chord: text(&r["chord"]),
				label: text(&r["label"]),
				scope: flag(r, "scope"),
			})
			.collect(),
	})
}

#[test]
fn cases() {
	let f = fixture();
	for case in f["cases"].as_array().expect("cases are an array") {
		let why = text(&case["why"]);
		let mut t = trie(&f, case);
		let steps: Vec<String> = case["keys"].as_array().expect("keys are an array").iter().map(|k| spell(t.key(&input(k)))).collect();
		let want: Vec<String> = case["steps"].as_array().expect("steps are an array").iter().map(text).collect();
		assert_eq!(steps, want, "{why}");
		if let Some(h) = case.get("hint") {
			assert_eq!(t.hint(), hint(h), "{why}");
		}
	}
}

#[test]
fn help_lists_every_bound_leaf() {
	let f = fixture();
	for h in f["help"].as_array().expect("help is an array") {
		let want: Vec<HelpRow> = h["rows"]
			.as_array()
			.expect("rows are an array")
			.iter()
			.map(|r| HelpRow {
				sequence: text(&r[0]),
				label: text(&r[1]),
			})
			.collect();
		assert_eq!(trie(&f, h).help(), want, "{h}");
	}
}

#[test]
fn invalid_keymaps_panic() {
	let f = fixture();
	for case in f["invalid"].as_array().expect("invalid is an array") {
		let keymap = Keymap { root: bindings(&case["keymap"]) };
		let panic = std::panic::catch_unwind(|| Trie::new(&keymap, Platform::Other, |_| true))
			.err()
			.unwrap_or_else(|| panic!("{} resolved", case["why"]));
		let msg = panic.downcast_ref::<String>().expect("assert! panics with a formatted String");
		assert!(msg.contains(&text(&case["panics"])), "{}: {msg}", case["why"]);
	}
}

#[test]
fn cancel_drops_the_open_scope() {
	let f = fixture();
	let mut t = trie(&f, &Value::Null);
	assert!(!t.cancel());
	t.key(&input(&"Alt+s".into()));
	assert!(t.cancel(), "the window lost focus with the leader open");
	assert_eq!(t.hint(), None);
}

#[test]
fn platforms() {
	for (p, want) in [
		("MacIntel", Platform::Mac),
		("iPhone", Platform::Mac),
		("iPad", Platform::Mac),
		("Win32", Platform::Other),
		("Linux x86_64", Platform::Other),
		("", Platform::Other),
	] {
		assert_eq!(Platform::from(p), want, "{p:?}");
	}
	let palette = Trigger {
		other: Chord { key: "k", ctrl: true, .. },
		mac: Chord { key: "k", meta: true, .. },
	};
	assert_eq!((palette.render(Platform::Mac), palette.render(Platform::Other)), ("⌘K".into(), "Ctrl+K".into()));
}
