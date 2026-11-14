//! The wasm half: custom-element registration, origin, mount, the [`mfe!`](crate::mfe!) macro, and
//! what an element tells its host ([`Hosted`]).

use std::{fmt::Display, future::Future, rc::Rc};

use dioxus::prelude::{Element, VirtualDom};
use js_sys::{Array, Object, Reflect};
use wasm_bindgen::prelude::*;
use web_sys::{AbortController, CustomEvent, CustomEventInit};

use crate::{
	kernel::i18n::{DEFAULT_LOCALE, LOCALES, Locale, Translator, negotiate},
	ui::keymap::{Binding, Chord, Node},
};

// The only JavaScript in the whole stack — the two things Rust can't express:
// subclassing `HTMLElement` (custom elements must extend it), and reading
// `import.meta.url` (a module-syntax form, not a value any Rust binding sees).
//
// `connectedCallback` fires on every (re)attachment, so it is guarded to mount
// once per element instance: a host router that detaches and re-inserts the node
// would otherwise stack a second live app on the first one's DOM. There is no
// paired `disconnectedCallback` because dioxus-web 0.7 exposes no teardown handle
// (`run() -> !` inside a bare `spawn_local`); the app therefore stays alive across
// a detach and is reused — with its DOM and its delegated listeners intact — when
// the element is re-inserted.
#[wasm_bindgen(inline_js = r#"
export function __ev_register(tag, mount){
  if (customElements.get(tag)) return;
  customElements.define(tag, class extends HTMLElement {
    connectedCallback(){
      if (this.__evMounted) return;
      this.__evMounted = true;
      // Keeps a host's session replay off what the app renders, however the element got here.
      this.classList.add('ph-no-capture');
      mount(this);
    }
  });
}
export function __ev_origin(){ return new URL(import.meta.url).origin; }
"#)]
extern "C" {
	#[wasm_bindgen(js_name = __ev_register)]
	fn js_register(tag: &str, mount: &js_sys::Function);
	#[wasm_bindgen(js_name = __ev_origin)]
	fn js_origin() -> String;
}

/// The bundle's own origin, from `import.meta.url`. Drives every URL the bundle
/// emits (server-fn base, stylesheet, seed images) so nothing is baked at build
/// time and the same artifact works behind any host origin.
pub fn bundle_origin() -> String {
	js_origin()
}

/// Define `tag` as a custom element that calls `mount(element)` on its first
/// connect. Idempotent twice over: a no-op if `tag` is already registered, and
/// `mount` runs at most once per element instance, so re-attaching an element
/// (as an SPA host router does on navigate-back) reuses the running app instead
/// of stacking a second one. The `mount` closure must outlive the page — the
/// caller `forget`s it.
pub fn register(tag: &str, mount: &Closure<dyn Fn(web_sys::Element)>) {
	js_register(tag, mount.as_ref().unchecked_ref());
}

/// Launch a Dioxus app rooted at `el` (the custom element instance), with `translator` and
/// [`Hosted`] as root contexts. Light DOM — the host's fonts/tokens/preflight cascade in, so the
/// bundle must not re-ship them.
///
/// Root contexts, not a cell the root reads: dioxus-web renders the root in a later task, so a
/// second element mounted in the same tick would see the first one's values. `LaunchBuilder` only
/// takes `Send` contexts, which an element is not.
pub fn launch_into(el: web_sys::Element, root: fn() -> Element, translator: Translator) {
	let vdom = VirtualDom::new(root).with_root_context(translator).with_root_context(Hosted(el.clone()));
	dioxus::web::launch::launch_virtual_dom(vdom, dioxus::web::Config::new().rootelement(el));
}

/// The element an `mfe!` app is mounted into, as root context: present exactly when the app is
/// hosted. What the app contributes to the page's one keymap and one undo history goes through it,
/// as the host-contract events of `@evinvest/mfe`; a hosted app adds no keydown listener of its own.
#[derive(Clone)]
pub struct Hosted(web_sys::Element);
impl Hosted {
	/// `ev:keymap`: `binding` joins the host's keymap, under the scope the host gives this element,
	/// until the returned [`Bound`] drops. A leaf is labelled by its command's `Display` and runs
	/// `run` with it; the host names it by its `id` under this element's tag.
	pub fn dispatch_keymap<C: Display + Clone + 'static>(&self, binding: &Binding<C>, run: impl Fn(&C) + 'static) -> Bound {
		fn chord(c: &Chord) -> Object {
			let o = Object::new();
			set(&o, "key", &c.key.into());
			set(&o, "ctrl", &c.ctrl.into());
			set(&o, "alt", &c.alt.into());
			set(&o, "meta", &c.meta.into());
			o
		}
		fn js<C: Display + Clone + 'static>(b: &Binding<C>, run: &Rc<dyn Fn(&C)>, closures: &mut Vec<Closure<dyn Fn()>>) -> Object {
			let on = Object::new();
			set(&on, "other", &chord(&b.on.other));
			set(&on, "mac", &chord(&b.on.mac));
			let o = Object::new();
			set(&o, "on", &on);
			match &b.node {
				Node::Run { id, command } => {
					set(&o, "id", &id.into());
					let leaf = Object::new();
					set(&leaf, "label", &command.to_string().into());
					let (run, command) = (Rc::clone(run), command.clone());
					let closure = Closure::<dyn Fn()>::new(move || run(&command));
					set(&leaf, "run", closure.as_ref());
					closures.push(closure);
					set(&o, "run", &leaf);
				}
				Node::Scope { label, children } => {
					set(&o, "label", &label.into());
					set(&o, "children", &children.iter().map(|c| js(c, run, closures)).collect::<Array>());
				}
			}
			o
		}
		let run: Rc<dyn Fn(&C)> = Rc::new(run);
		let mut closures = Vec::new();
		let controller = AbortController::new().expect("AbortController is constructible in a window");
		let detail = Object::new();
		set(&detail, "binding", &js(binding, &run, &mut closures));
		set(&detail, "signal", &controller.signal());
		self.dispatch("ev:keymap", &detail);
		Bound { controller, closures }
	}

	/// `ev:undo`: a change this element just made, for the page's one undo history. `undo` and
	/// `redo` write its before and after value back; an `Err` rejects, which the host reads as the
	/// state having moved on.
	pub fn dispatch_undo<U, R, E>(&self, label: &str, undo: impl Fn() -> U + 'static, redo: impl Fn() -> R + 'static)
	where
		U: Future<Output = Result<(), E>> + 'static,
		R: Future<Output = Result<(), E>> + 'static,
		E: Display, {
		fn promised<F: Future<Output = Result<(), E>> + 'static, E: Display>(f: impl Fn() -> F + 'static) -> JsValue {
			// Owned by the JS function from here: the host's history keeps it as long as it wants it.
			Closure::<dyn Fn() -> js_sys::Promise>::new(move || {
				let pending = f();
				wasm_bindgen_futures::future_to_promise(async move { pending.await.map(|()| JsValue::UNDEFINED).map_err(|e| js_sys::Error::new(&e.to_string()).into()) })
			})
			.into_js_value()
		}
		let detail = Object::new();
		set(&detail, "label", &label.into());
		set(&detail, "undo", &promised(undo));
		set(&detail, "redo", &promised(redo));
		self.dispatch("ev:undo", &detail);
	}

	fn dispatch(&self, name: &str, detail: &JsValue) {
		let init = CustomEventInit::new();
		init.set_bubbles(true);
		init.set_composed(true);
		init.set_detail(detail);
		let event = CustomEvent::new_with_event_init_dict(name, &init).expect("a CustomEvent of any name is constructible");
		self.0.dispatch_event(&event).expect("dispatching an untrusted event never throws");
	}
}

/// A binding in the host's keymap; it leaves when this drops.
#[must_use = "the binding leaves the host's keymap when this drops"]
pub struct Bound {
	controller: AbortController,
	closures: Vec<Closure<dyn Fn()>>,
}

impl Drop for Bound {
	fn drop(&mut self) {
		self.controller.abort();
		self.closures.clear(); // after the abort: the host may call a leaf until it hears it
	}
}

/// The language the host page is written in, read off the DOM `el` is mounted
/// into. The Rust mirror of `localeOfElement` in `@evinvest/i18n`.
///
/// Read from the DOM rather than taken as an attribute or a prop, because a host
/// is not bound to set attributes before the element connects (the platform's
/// `RemoteElement` does, a hand-written host may not), and anything pushed in late
/// reads as absent at `connectedCallback` time. `lang` is the platform's own
/// answer to "what language is this subtree", every host that serves more than one
/// already sets it, and it is readable the instant the node is attached.
///
/// A regional tag resolves to its base language (`ru-RU` → `ru`); an absent or
/// unpublished `lang` reads as [`DEFAULT_LOCALE`].
pub fn host_locale(el: &web_sys::Element) -> Locale {
	el.closest("[lang]")
		.expect("\"[lang]\" is a valid selector")
		.and_then(|scope| scope.get_attribute("lang"))
		.map_or(DEFAULT_LOCALE, |lang| negotiate(Some(&lang), &LOCALES))
}

fn set(o: &Object, key: &str, value: &JsValue) {
	Reflect::set(o, &key.into(), value).expect("a plain object takes any property");
}

/// Define a microfrontend producer bundle. Expands in the producer crate (so its
/// `dioxus` rsx, `wasm-bindgen`, and `web-sys` resolve there), generating the
/// custom-element registration, the `wasm-bindgen(start)` entrypoint, and the
/// [`MfeManifest`](crate::mfe::MfeManifest) `MFE_MANIFEST` the build serialises as `mfe.json`.
///
/// ```ignore
/// ev_lib::mfe! {
///     service: "real-estate", name: "overview", kind: component,
///     root: real_estate_allocation::embed::Overview, stylesheet: "mfe.css",
///     messages: crate::catalogue
/// }
/// ```
///
/// Naming is enforced: the tag is `mfe-{service}-{name}` and the registry name is
/// `{service}.{name}` — the host can't drift from the producer's identity. `kind`
/// is a [`MfeKind`](crate::mfe::MfeKind) word; any other fails to compile. One
/// invocation per crate (it owns the single `wasm-bindgen(start)`).
///
/// `messages` is a `fn(Locale) -> Messages` and is **required**, not optional. A
/// producer with no copy passes an empty catalogue as one deliberate, reviewable
/// line; a producer *with* copy cannot forget to resolve its locale, which is
/// the bug the requirement exists to prevent. The macro resolves
/// [`host_locale`](crate::mfe::host_locale) at mount and provides a
/// [`Translator`](crate::i18n::Translator) and the element's
/// [`Hosted`](crate::mfe::Hosted) as Dioxus root contexts, so every component
/// below reaches them with `use_context`.
#[macro_export]
macro_rules! mfe {
	(service: $service:literal,name: $name:literal,kind: $kind:ident,root: $root:path,stylesheet: $stylesheet:literal,messages: $messages:path $(,)?) => {
		const __EV_TAG: &str = concat!("mfe-", $service, "-", $name);

		/// The registry contract, serialised by the build as `mfe.json`.
		pub const MFE_MANIFEST: $crate::mfe::MfeManifest = $crate::mfe::MfeManifest {
			name: concat!($service, ".", $name),
			tag: __EV_TAG,
			kind: $crate::mfe::MfeKind::parse(stringify!($kind)),
		};

		fn __ev_root() -> ::dioxus::prelude::Element {
			use ::dioxus::prelude::*;
			// Alias the root via native `use` so the `$root:path` fragment never
			// enters the rsx proc-macro (captured fragments are opaque to it).
			// PascalCase so rsx reads it as a component, not an HTML element.
			use $root as EvMfeRoot;
			rsx! {
				document::Stylesheet { href: format!("{}/mfe/{}", $crate::mfe::bundle_origin(), $stylesheet) }
				EvMfeRoot {}
			}
		}

		fn __ev_mount(el: ::web_sys::Element) {
			let locale = $crate::mfe::host_locale(&el);
			$crate::mfe::launch_into(el, __ev_root, $crate::i18n::Translator::new($messages(locale), locale));
		}

		#[::wasm_bindgen::prelude::wasm_bindgen(start)]
		pub fn __ev_start() {
			let closure = ::wasm_bindgen::closure::Closure::<dyn Fn(::web_sys::Element)>::new(__ev_mount);
			$crate::mfe::register(__EV_TAG, &closure);
			// The element can mount at any time after registration; the closure must
			// outlive this fn, so hand it to the JS runtime permanently.
			closure.forget();
		}
	};
}
