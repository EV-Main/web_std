use dioxus::prelude::*;

use crate::{
	cn,
	ui::{
		keymap::Hint,
		uikit::dioxus::{KEY_HINT, KEY_HINT_PREFIX, KEY_HINT_ROW, Kbd, Slot},
	},
};

/// The which-key popup for the scope a chord has opened: what each next key does. Mirrors the TS `KeyHint`.
#[component]
pub fn KeyHint(hint: Hint, #[props(default)] class: String) -> Element {
	let Hint { prefix, rows } = hint;
	let cls = cn!(KEY_HINT, class);
	rsx! {
		div { class: cls, "data-slot": Slot::KeyHint.as_str(), "data-enter": "rise",
			div { class: KEY_HINT_PREFIX, {prefix} }
			for row in rows {
				div {
					key: "{row.chord}",
					class: KEY_HINT_ROW,
					"data-slot": Slot::KeyHintRow.as_str(),
					"data-scope": row.scope.then_some(""),
					Kbd { {row.chord} }
					span { {row.label} }
				}
			}
		}
	}
}
