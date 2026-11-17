//! `tests/fixtures/views/views.json`, which `ts/views` reads too: a host's table with two services'
//! nested in it (the conductor's, sites' and review_archive's shapes), its hrefs both ways, and what
//! is no view. `BLESS=1` rewrites the table and the hrefs from what the Rust says.
#![cfg(feature = "views")]

use std::collections::BTreeMap;

use ev_lib::views::{At, Table, Views};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy)]
enum Sources {
	Manage,
}

impl Sources {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Manage => "sa:admin:sources:manage",
		}
	}
}

#[derive(Clone, Copy)]
enum Members {
	ActAs,
}

impl Members {
	const fn as_str(self) -> &'static str {
		match self {
			Self::ActAs => "sa:review_archive:members:act_as",
		}
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Tab {
	Launch,
	Browser,
	Kit,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Issue {
	/// No point placed yet.
	Unplaced,
	/// Closed on Google.
	Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Stage {
	Created,
	Won,
}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct Tier {
	weight: f64,
	show: bool,
}

/// Beside every page.
#[derive(Serialize, Deserialize, JsonSchema)]
struct Outline {
	/// The GMBs being edited; empty, none yet.
	gmbs: Option<Vec<i64>>,
	gmail: Vec<i64>,
	find: Option<String>,
	issue: Option<Issue>,
}

#[derive(Debug, PartialEq, Views)]
#[views(carried = Outline)]
enum Conductor {
	/// The map of the caller's GMBs.
	#[view("/", key = 'h')]
	Home {
		gmb: Option<i64>,
		tab: Option<Tab>,
		trash: bool,
		/// `<gmail>,<trade>`: the Add a GBP panel.
		add: Option<(i64, i64)>,
		at: Option<(f64, f64, f64)>,
		/// Empty: draw a new area.
		kit: Option<String>,
		tiers: Option<BTreeMap<String, Tier>>,
	},
	/// Source keys and the sites they connect.
	#[view("/sources", needs = Sources::Manage, key = 'c')]
	Sources,
	/// The assistant, full screen.
	#[view("/assistant")]
	Assistant { chat: Option<String> },
	/// sites' pages, its element's to route.
	#[view("/sites", nest = "sites", key = 's', scope = 'v')]
	Sites { below: String },
	/// The review archive's dashboard.
	#[view("/review_archive", nest = "review_archive", key = 'r')]
	ReviewArchive { below: String },
}

/// `GET /leads`' query: the Leads view's filter keys are its fields.
#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct LeadsQuery {
	stage: Option<Stage>,
	overdue: bool,
	created_from: Option<String>,
}

#[derive(Debug, PartialEq, Views)]
enum Sites {
	/// Where the base leads: the leads for who works them, else the funnel.
	#[view("/")]
	Start,
	/// The leads, filtered.
	#[view("/leads", key = 'l')]
	Leads {
		#[view(flatten)]
		filter: LeadsQuery,
		lead: Option<String>,
	},
	/// A brand's places.
	#[view("/places", key = 'p')]
	Places { brand: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Views)]
enum Board {
	/// Every GMB of the member's.
	#[view("/gmbs", key = 'g')]
	Home,
	/// A gmail's GMBs.
	#[view("/gmails/{gmail}")]
	Gmail { gmail: i64 },
	/// A GMB's board.
	#[view("/gmbs/{gmb}")]
	Gmb { gmb: i64 },
	/// Telegram and the archive's settings.
	#[view("/settings", key = 's')]
	Settings,
}

#[derive(Debug, PartialEq, Views)]
enum Archive {
	/// The pick of a member to open a tab for.
	#[view("/act-as", needs = Members::ActAs)]
	Pick,
	#[view("/members/{member}", nest, needs = Members::ActAs)]
	Theirs { member: i64, view: Board },
	#[view("", nest)]
	Mine { view: Board },
}

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/views/views.json");

/// The conductor's table as its catalog has it: both services' under their nests.
fn merged() -> Table {
	let mut table = Conductor::table().clone();
	table.nest("sites", Sites::table().clone()).unwrap();
	table.nest("review_archive", Archive::table().clone()).unwrap();
	table
}

#[test]
fn fixture() {
	let mut fixture: Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).expect("the fixture is committed")).expect("the fixture is JSON");
	let table = merged();
	let bless = std::env::var_os("BLESS").is_some();
	if bless {
		fixture["table"] = serde_json::to_value(&table).unwrap();
	}
	assert_eq!(
		serde_json::from_value::<Table>(fixture["table"].clone()).unwrap(),
		table,
		"the derived table is the fixture's (BLESS=1 rewrites it)"
	);
	for case in fixture["cases"].as_array_mut().unwrap() {
		let at: At = serde_json::from_value(case["at"].clone()).unwrap();
		let carried: Map<String, Value> = serde_json::from_value(case["carried"].clone()).unwrap();
		let href = table.href(&at, &carried).unwrap();
		if bless {
			case["href"] = href.clone().into();
		}
		assert_eq!(href, case["href"], "{at:?}");
		assert_eq!(table.parse(&href).unwrap(), (at, carried), "{href}");
	}
	for href in fixture["refused"].as_array().unwrap() {
		let href = href.as_str().unwrap();
		assert!(table.parse(href).is_err(), "{href} is no view, yet parses as {:?}", table.parse(href));
	}
	if bless {
		std::fs::write(FIXTURE, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
	}
}

#[test]
fn a_view_parses_its_own_href() {
	fn check<V: Views + PartialEq + std::fmt::Debug>(views: &[V]) {
		for v in views {
			assert_eq!(&V::parse(&v.href()).unwrap(), v, "{}", v.href());
		}
	}
	let tiers = BTreeMap::from([("2.FR".to_owned(), Tier { weight: 0.5, show: true })]);
	check(&[
		Conductor::Home {
			gmb: Some(5),
			tab: Some(Tab::Kit),
			trash: true,
			add: Some((3, 4)),
			at: Some((52.52, 13.405, 12.0)),
			kit: Some(String::new()),
			tiers: Some(tiers),
		},
		Conductor::Home {
			gmb: None,
			tab: None,
			trash: false,
			add: None,
			at: None,
			kit: None,
			tiers: None,
		},
		Conductor::Sources,
		Conductor::Assistant { chat: Some("a/b c".into()) },
		Conductor::Sites { below: "/leads?stage=won".into() },
		Conductor::Sites { below: String::new() },
		Conductor::ReviewArchive { below: "/members/3/gmbs/5".into() },
	]);
	check(&[
		Archive::Pick,
		Archive::Theirs {
			member: 3,
			view: Board::Gmb { gmb: 5 },
		},
		Archive::Mine { view: Board::Home },
		Archive::Mine { view: Board::Gmail { gmail: 2 } },
	]);
	check(&[
		Sites::Start,
		Sites::Leads {
			filter: LeadsQuery {
				stage: Some(Stage::Created),
				overdue: true,
				created_from: Some("2026-11-01".into()),
			},
			lead: None,
		},
		Sites::Leads {
			filter: LeadsQuery {
				stage: None,
				overdue: false,
				created_from: None,
			},
			lead: Some("l 1".into()),
		},
	]);
}

#[test]
#[should_panic(expected = "path is the same")]
fn two_views_of_one_path_are_refused() {
	#[derive(Views)]
	enum Clash {
		/// One.
		#[view("/a/{x}")]
		One { x: i64 },
		/// Another.
		#[view("/a/{y}")]
		Other { y: String },
	}
	Clash::table();
}

#[test]
#[should_panic(expected = "two fields' key")]
fn a_flattened_key_is_no_other_fields() {
	#[derive(Views)]
	enum Clash {
		/// The leads, filtered twice over.
		#[view("/leads")]
		Leads {
			#[view(flatten)]
			filter: LeadsQuery,
			stage: Option<Stage>,
		},
	}
	Clash::table();
}

#[test]
#[should_panic(expected = "a view opens on one permission")]
fn a_nest_and_its_view_do_not_both_name_a_permission() {
	#[derive(Views)]
	enum Inner {
		/// Its own.
		#[view("/settings", needs = Sources::Manage)]
		Settings,
	}
	#[derive(Views)]
	enum Outer {
		#[view("/members/{member}", nest, needs = Members::ActAs)]
		Theirs { member: i64, view: Inner },
	}
	Outer::table();
}

#[cfg(feature = "views_dioxus")]
#[test]
fn a_routable_routes_through_the_views() {
	use dioxus::prelude::*;
	use ev_lib::views::Routed;

	#[component]
	fn Page(at: Routed<Board>) -> Element {
		rsx! { "{at.0:?}" }
	}

	#[derive(Clone, Debug, PartialEq, Routable)]
	enum Route {
		#[route("/:..at", Page)]
		At { at: Routed<Board> },
	}

	for (href, view) in [("/gmbs/5", Board::Gmb { gmb: 5 }), ("/gmbs", Board::Home), ("/settings", Board::Settings)] {
		let route: Route = href.parse().unwrap();
		assert_eq!(route, Route::At { at: Routed(view) });
		assert_eq!(route.to_string(), href);
	}
}

#[test]
fn an_enum_with_some_words_documented_is_its_words() {
	#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
	#[serde(rename_all = "snake_case")]
	enum Booking {
		None,
		/// Asked for a slot, none had yet.
		Requested,
		Booked,
	}
	#[derive(Debug, PartialEq, Views)]
	enum Partly {
		/// The leads, by where their booking stands.
		#[view("/leads")]
		Leads { booking: Option<Booking> },
	}
	for booking in [None, Some(Booking::None), Some(Booking::Requested), Some(Booking::Booked)] {
		let view = Partly::Leads { booking };
		assert_eq!(Partly::parse(&view.href()).unwrap(), view, "{}", view.href());
	}
}

#[test]
fn a_type_its_check_narrows_is_sampled_by_its_example() {
	/// Lowercase only: a text with a space is none.
	#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
	#[serde(try_from = "String")]
	struct Slug(String);
	impl TryFrom<String> for Slug {
		type Error = String;

		fn try_from(s: String) -> Result<Self, String> {
			s.bytes().all(|b| b.is_ascii_lowercase()).then(|| Self(s.clone())).ok_or(s)
		}
	}
	impl JsonSchema for Slug {
		fn schema_name() -> std::borrow::Cow<'static, str> {
			"Slug".into()
		}

		fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
			schemars::json_schema!({ "type": "string", "pattern": "^[a-z]+$", "examples": ["aquafix"] })
		}
	}
	#[derive(Debug, PartialEq, Views)]
	enum Narrowed {
		/// A brand's leads, one of them open.
		#[view("/leads/{brand}")]
		Leads { brand: Slug, lead: Option<(Slug, Slug)>, tags: Vec<Slug> },
	}
	let view = Narrowed::Leads {
		brand: Slug("vifnet".into()),
		lead: Some((Slug("vifnet".into()), Slug("royat".into()))),
		tags: vec![Slug("new".into())],
	};
	assert_eq!(Narrowed::parse(&view.href()).unwrap(), view);
}
