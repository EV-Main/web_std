use leptos::prelude::*;

use crate::{
	cn,
	ui::{
		keymap::Hint,
		uikit::leptos::{KEY_HINT, KEY_HINT_PREFIX, KEY_HINT_ROW, Kbd, Slot},
	},
};

/// The which-key popup for the scope a chord has opened: what each next key does. Mirrors the TS `KeyHint`.
#[component]
pub fn KeyHint(hint: Hint, #[prop(optional, into)] class: String) -> impl IntoView {
	let Hint { prefix, rows } = hint;
	view! {
		<div class=cn!(KEY_HINT, class) data-slot=Slot::KeyHint.as_str() data-enter="rise">
			<div class=KEY_HINT_PREFIX>{prefix}</div>
			{rows
				.into_iter()
				.map(|row| {
					view! {
						<div
							class=KEY_HINT_ROW
							data-slot=Slot::KeyHintRow.as_str()
							data-scope=row.scope.then_some("")
						>
							<Kbd>{row.chord}</Kbd>
							<span>{row.label}</span>
						</div>
					}
				})
				.collect_view()}
		</div>
	}
}
