/// One entry of a `NotificationBell`. Mirrors the TS `HeaderNotification`;
/// the TS fields take any node, these take text, like `CommandPaletteItem`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HeaderNotification {
	/// Reported to `on_select`.
	pub id: String,
	pub title: String,
	pub description: Option<String>,
	/// Already formatted: "2m ago".
	pub time: Option<String>,
	pub unread: bool,
}
