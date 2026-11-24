/// Where the panel sits under its trigger for an `align`: `start` pins the left
/// edges, `end` the right, anything else centres it.
pub(crate) fn popover_placement(align: &str) -> &'static str {
	match align {
		"start" => "absolute top-full left-0 mt-1",
		"end" => "absolute top-full right-0 mt-1",
		_ => "absolute top-full left-1/2 -translate-x-1/2 mt-1",
	}
}

/// How far a panel spanning `panel` (left, right) moves sideways to stay inside `view`, 8px off its edges;
/// a panel wider than the view keeps its left edge in.
pub(crate) fn popover_shift(panel: (f64, f64), view: (f64, f64)) -> f64 {
	const MARGIN: f64 = 8.;
	let over = (panel.1 - (view.1 - MARGIN)).max(0.);
	let under = (view.0 + MARGIN - (panel.0 - over)).max(0.);
	under - over
}
