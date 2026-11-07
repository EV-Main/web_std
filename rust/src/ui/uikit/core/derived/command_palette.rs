use crate::ui::keymap::{Chord, Trigger};

pub(crate) const COMMAND_PALETTE: Trigger = Trigger {
	other: Chord { key: "k", ctrl: true, .. },
	mac: Chord { key: "k", meta: true, .. },
};
