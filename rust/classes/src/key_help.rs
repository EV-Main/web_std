pub const KEY_HELP_LIST: &str = "flex max-h-[60vh] flex-col overflow-y-auto";
pub const KEY_HELP_ROW: &str = "flex h-(--control-h-sm) shrink-0 items-center justify-between gap-4 text-body";
pub const KEY_HELP_LABEL: &str = "truncate text-ink-mid";

/// The `KeyHelp`'s own strings. English by default; a caller translates by overriding fields.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts_gen", derive(serde::Serialize), serde(rename_all = "camelCase"))]
pub struct KeyHelpLabels {
	/// The dialog's title, and the label of the leaf that opens it.
	pub title: String,
}
impl Default for KeyHelpLabels {
	fn default() -> Self {
		Self { title: "Keybinds".to_owned() }
	}
}
