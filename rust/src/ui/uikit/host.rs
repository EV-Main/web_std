//! Host access both ports need and the core may not have: the clock, the
//! clipboard and the page's keymap. Framework-free, so one copy serves both.

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub(crate) use page::bind;

use crate::ui::uikit::core::CalendarDate;

/// Writes `text` to the clipboard, then calls `done` with whether it got
/// there. The mirror of the TS `writeClipboard` behind `KeyValue`.
///
/// The async clipboard API needs a secure context and a user gesture, so call
/// it from a press. An insecure origin, an old webview or a denied permission
/// falls back to a selection and `execCommand("copy")`.
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub fn write_clipboard(text: &str, done: impl FnOnce(bool) + 'static) {
	use std::{cell::RefCell, rc::Rc};

	use web_sys::{
		js_sys::{Function, Reflect},
		wasm_bindgen::{JsCast, JsValue, closure::Closure},
	};

	let Some(window) = web_sys::window() else { return done(false) };
	let navigator = window.navigator();
	// `navigator.clipboard` is missing outside a secure context and in old
	// webviews; the binding does not return an `Option`, so ask first.
	let has_api = window.is_secure_context() && Reflect::get(&navigator, &JsValue::from_str("clipboard")).is_ok_and(|c| !c.is_undefined());
	if !has_api {
		return done(copy_by_selection(text));
	}
	let promise = navigator.clipboard().write_text(text);
	// One of the two handlers runs; both own the callback, so it sits in a
	// shared slot that the first to run empties.
	let slot = Rc::new(RefCell::new(Some(done)));
	let resolved = {
		let slot = Rc::clone(&slot);
		Closure::once_into_js(move |_: JsValue| {
			if let Some(done) = slot.borrow_mut().take() {
				done(true);
			}
		})
	};
	let text = text.to_owned();
	let rejected = {
		let slot = Rc::clone(&slot);
		Closure::once_into_js(move |_: JsValue| {
			if let Some(done) = slot.borrow_mut().take() {
				done(copy_by_selection(&text));
			}
		})
	};
	let then = Reflect::get(&promise, &JsValue::from_str("then")).ok().and_then(|f| f.dyn_into::<Function>().ok());
	let attached = then.is_some_and(|then| then.call2(&promise, &resolved, &rejected).is_ok());
	if !attached && let Some(done) = slot.borrow_mut().take() {
		done(false);
	}
}

/// Today on the host clock, or `None` where the build has no clock to read.
///
/// Web (`wasm32` + the `wasm` feature) reads the browser's local date, like the
/// TS port's `new Date()`. Native reads `SystemTime` and takes the **UTC** date:
/// the local zone needs tz data the dep-light kit does not carry, so near
/// midnight a native host can be a day off its wall clock. Bare `wasm32` without
/// `wasm` has no clock (`SystemTime::now` panics there).
///
/// Server-rendered and hydrated, the server's UTC date and the browser's local
/// one differ near midnight, so the opened month and `data-today` would not
/// match on hydration — the same as the TS `new Date()`. An SSR page passes
/// `default_month` and `today` explicitly, computed once.
pub(crate) fn today() -> Option<CalendarDate> {
	#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
	{
		let now = web_sys::js_sys::Date::new_0();
		Some(CalendarDate::new(now.get_full_year() as i32, now.get_month() + 1, now.get_date()))
	}
	#[cfg(not(target_arch = "wasm32"))]
	{
		let secs = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
			Ok(after) => after.as_secs() as i64,
			Err(before) => -(before.duration().as_secs() as i64),
		};
		Some(CalendarDate::from_unix_days(secs.div_euclid(86_400)))
	}
	#[cfg(all(target_arch = "wasm32", not(feature = "wasm")))]
	{
		None
	}
}

/// Milliseconds on some monotonic-enough clock, for the type-ahead window;
/// `None` on bare `wasm32` without `wasm`, where `SystemTime::now` panics.
pub(crate) fn now_ms() -> Option<f64> {
	#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
	{
		Some(web_sys::js_sys::Date::now())
	}
	#[cfg(not(target_arch = "wasm32"))]
	{
		Some(
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.expect("the host clock is past 1970")
				.as_secs_f64()
				* 1000.0,
		)
	}
	#[cfg(all(target_arch = "wasm32", not(feature = "wasm")))]
	{
		None
	}
}

/// The fallback for a browser without the async clipboard API.
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
fn copy_by_selection(text: &str) -> bool {
	use web_sys::wasm_bindgen::JsCast;

	let Some(document) = web_sys::window().and_then(|w| w.document()) else { return false };
	// A modal pulls focus back into itself, which would drop a selection made
	// in `<body>`, so the helper lives inside the dialog the user is in.
	let dialog = document.active_element().and_then(|el| el.closest("[role=\"dialog\"]").ok().flatten());
	let Some(host) = dialog.or_else(|| document.body().map(Into::into)) else { return false };
	let Ok(area) = document.create_element("textarea") else { return false };
	let Ok(area) = area.dyn_into::<web_sys::HtmlTextAreaElement>() else { return false };
	area.set_value(text);
	// Attribute writes on a fresh element cannot fail in practice; a failure
	// only shows the helper for the instant it lives.
	let _ = area.set_attribute("readonly", "");
	let _ = area.set_attribute("style", "position: fixed; opacity: 0");
	if host.append_child(&area).is_err() {
		return false;
	}
	area.select();
	let copied = document.dyn_ref::<web_sys::HtmlDocument>().and_then(|d| d.exec_command("copy").ok()).unwrap_or(false);
	area.remove();
	copied
}

/// What a key the kit binds runs. Labelled for a host's hint and help.
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
#[derive(Clone)]
pub(crate) struct Leaf {
	pub(crate) label: &'static str,
	pub(crate) run: std::rc::Rc<dyn Fn()>,
}
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
impl std::fmt::Display for Leaf {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.label)
	}
}

/// The page's own keymap, for a Rust app that is the page: every binding bound here, as one
/// [`Trie`](crate::ui::keymap::Trie) heard by one `window` keydown listener in the capture phase,
/// ahead of the page's own handlers. The mirror of the TS `KeymapProvider`'s root.
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
mod page {
	use std::cell::RefCell;

	use web_sys::wasm_bindgen::{JsCast, closure::Closure};

	use super::Leaf;
	use crate::ui::keymap::{Binding, KeyInput, Keymap, Platform, Step, Trie};

	struct Page {
		next: u64,
		bound: Vec<(u64, Binding<Leaf>)>,
		trie: Trie<Leaf>,
	}

	impl Page {
		fn rebuild(&mut self) {
			let keymap = Keymap {
				root: self.bound.iter().map(|(_, b)| b.clone()).collect(),
			};
			self.trie = Trie::new(&keymap, Platform::current(), |_| true);
		}
	}

	thread_local! {
		static PAGE: RefCell<Option<Page>> = const { RefCell::new(None) };
	}

	/// In the page's keymap until dropped.
	pub(crate) struct PageBinding(u64);

	pub(crate) fn bind(binding: Binding<Leaf>) -> PageBinding {
		PAGE.with_borrow_mut(|slot| {
			let page = slot.get_or_insert_with(|| {
				listen();
				Page {
					next: 0,
					bound: Vec::new(),
					trie: Trie::new(&Keymap { root: Vec::new() }, Platform::current(), |_| true),
				}
			});
			let id = page.next;
			page.next += 1;
			page.bound.push((id, binding));
			page.rebuild();
			PageBinding(id)
		})
	}

	impl Drop for PageBinding {
		fn drop(&mut self) {
			PAGE.with_borrow_mut(|slot| {
				let page = slot.as_mut().expect("a PageBinding is only made by `bind`, which creates the page");
				page.bound.retain(|(id, _)| *id != self.0);
				page.rebuild();
			});
		}
	}

	// Attached for the page's lifetime: a leaf whose run drops the last binding must not free the
	// closure it runs inside.
	fn listen() {
		let listener = Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(|e: web_sys::KeyboardEvent| {
			let step = PAGE.with_borrow_mut(|slot| slot.as_mut().expect("the listener is attached with the page").trie.key(&KeyInput::from(&e)));
			if let Step::Pass { .. } = step {
				return;
			}
			e.prevent_default();
			e.stop_propagation();
			// After the borrow: a leaf may bind or drop a binding.
			if let Step::Run { command, .. } = step {
				(command.run)();
			}
		});
		web_sys::window()
			.expect("keybinds run in a browser window")
			.add_event_listener_with_callback_and_bool("keydown", listener.as_ref().unchecked_ref(), true)
			.expect("a window takes a keydown listener");
		listener.forget();
	}
}
