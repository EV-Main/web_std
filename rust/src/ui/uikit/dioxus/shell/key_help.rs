use dioxus::prelude::*;
pub use ev_lib_classes::KeyHelpLabels;

use crate::ui::{
	keymap::HelpRow,
	uikit::dioxus::{Dialog, DialogContent, DialogHeader, DialogTitle, KEY_HELP_LABEL, KEY_HELP_LIST, KEY_HELP_ROW, Kbd, Slot, primitives::use_stable_id},
};

/// Every keybind the page has, as a dialog. Mirrors the TS `KeyHelp`.
///
/// It is a [`Dialog`], so it keeps the kit's overlay limits: rendered inline
/// with `position: fixed`, no portal and no focus trap.
#[component]
pub fn KeyHelp(
	open: Option<bool>,
	#[props(default)] default_open: bool,
	on_open_change: Option<EventHandler<bool>>,
	rows: Vec<HelpRow>,
	#[props(default)] labels: KeyHelpLabels,
	#[props(default)] class: String,
) -> Element {
	let title_id = use_stable_id("key-help-title");
	rsx! {
		Dialog { open, default_open, on_open_change,
			DialogContent { aria_labelledby: title_id.clone(), class,
				DialogHeader {
					DialogTitle { id: title_id, {labels.title} }
				}
				ul { class: KEY_HELP_LIST, "data-slot": Slot::KeyHelp.as_str(),
					for row in rows {
						li { key: "{row.sequence}", class: KEY_HELP_ROW, "data-slot": Slot::KeyHelpRow.as_str(),
							span { class: KEY_HELP_LABEL, {row.label} }
							Kbd { {row.sequence} }
						}
					}
				}
			}
		}
	}
}
