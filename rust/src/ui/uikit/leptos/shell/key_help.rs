pub use ev_lib_classes::KeyHelpLabels;
use leptos::prelude::*;

use crate::ui::{
	keymap::HelpRow,
	uikit::leptos::{
		Dialog, DialogContent, DialogHeader, DialogTitle, KEY_HELP_LABEL, KEY_HELP_LIST, KEY_HELP_ROW, Kbd, Slot,
		primitives::{use_controllable, use_stable_id},
	},
};

/// Every keybind the page has, as a dialog. Mirrors the TS `KeyHelp`.
///
/// It is a [`Dialog`], so it keeps the kit's overlay limits: rendered inline
/// with `position: fixed`, no portal and no focus trap.
#[component]
pub fn KeyHelp(
	#[prop(optional, into)] open: MaybeProp<bool>,
	#[prop(optional)] default_open: bool,
	#[prop(optional)] on_open_change: Option<Callback<bool>>,
	rows: Vec<HelpRow>,
	#[prop(optional)] labels: KeyHelpLabels,
	#[prop(optional, into)] class: String,
) -> impl IntoView {
	let state = use_controllable(open, default_open, on_open_change);
	let title_id = use_stable_id("key-help-title");
	let labelled_by = title_id.clone();
	// Run on every opening, so it clones what the inner parts take by value.
	let body = move || {
		let (title_id, title, rows) = (title_id.clone(), labels.title.clone(), rows.clone());
		view! {
			<DialogHeader>
				<DialogTitle id=title_id>{title}</DialogTitle>
			</DialogHeader>
			<ul class=KEY_HELP_LIST data-slot=Slot::KeyHelp.as_str()>
				{rows
					.into_iter()
					.map(|row| {
						view! {
							<li class=KEY_HELP_ROW data-slot=Slot::KeyHelpRow.as_str()>
								<span class=KEY_HELP_LABEL>{row.label}</span>
								<Kbd>{row.sequence}</Kbd>
							</li>
						}
					})
					.collect_view()}
			</ul>
		}
	};
	view! {
		<Dialog
			open=Signal::derive(move || state.get())
			on_open_change=Callback::new(move |next| state.set(next))
		>
			<DialogContent aria_labelledby=labelled_by class>
				{body()}
			</DialogContent>
		</Dialog>
	}
}
