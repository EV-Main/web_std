// What an element tells its host, as DOM events dispatched from the element.
// All of them bubble and are `composed`, so a host that wraps the element in its
// own shadow root still hears them.
//
// `ev:keymap` and `ev:undo` carry closures: an element runs in the page's realm.
//
// `signout` keeps its unprefixed name: it is part of the frozen apiVersion-2
// chip contract, and renaming it to `ev:signout` would be apiVersion 3.

/**
 * The host-contract version this package speaks. A producer sets it as a static
 * on its element class (`static apiVersion = API_VERSION`); a host that passes
 * it as `minApiVersion` refuses an older bundle rather than half-render it (the
 * loader's default, 0, accepts any). Additive changes keep the number; a renamed
 * attribute or event bumps it.
 */
import type { Binding, Chord, Trigger } from '@evinvest/keymap';

export const API_VERSION = 2;

/** Whether a defined element class speaks at least `min` of the host contract. */
export function speaksApi(ctor: unknown, min: number): boolean {
  if (typeof ctor !== 'function') return false;
  const version: unknown = Reflect.get(ctor, 'apiVersion');
  return typeof version === 'number' && version >= min;
}

/**
 * Cancelable: a plain same-origin link click inside the element, offered to the
 * host's router. The host calls `preventDefault()` to take it and pushes the
 * route itself; left alone, the browser follows the link.
 */
export const NAVIGATE_EVENT = 'ev:navigate';
/** The user finished signing in inside the element; the host starts its own RP login. `detail` is null. */
export const SIGNED_IN_EVENT = 'ev:signed-in';
/** Sign out was picked in host mode; the host ends its own session. `detail` is null. */
export const SIGNOUT_EVENT = 'signout';

/**
 * The element contributes a binding to the page's keymap. The host places it under a scope it
 * assigns to the element (the element never claims a root chord, and two elements never
 * collide) and names each leaf `<tag>/<id>`; it is bound while the element is connected, until
 * `signal` aborts.
 */
export const KEYMAP_EVENT = 'ev:keymap';
/** The element made a change it can take back: an entry for the page's one undo history. */
export const UNDO_EVENT = 'ev:undo';

/** `detail` of {@link NAVIGATE_EVENT}: the destination as path + query + hash. */
export interface NavigateDetail {
  href: string;
}

/** What a leaf an element binds runs, and the label the page's hint and help show for it. */
export interface ElementLeaf {
  label: string;
  run: () => void;
}

export type ElementBinding = Binding<ElementLeaf>;

/** `detail` of {@link KEYMAP_EVENT}. */
export interface KeymapDetail {
  binding: ElementBinding;
  signal: AbortSignal;
}

/**
 * `detail` of {@link UNDO_EVENT}: a change, as the two closures that write its before and its
 * after value back. Each rejects, rather than write, once the state is no longer the value it
 * left (another operator, a live update changed it): the host then drops its whole history.
 */
export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** Every event of the host contract, by name, with the event type a listener receives. */
export interface MfeEventMap {
  [NAVIGATE_EVENT]: CustomEvent<NavigateDetail>;
  [KEYMAP_EVENT]: CustomEvent<KeymapDetail>;
  [UNDO_EVENT]: CustomEvent<UndoEntry>;
  [SIGNED_IN_EVENT]: CustomEvent<null>;
  [SIGNOUT_EVENT]: CustomEvent<null>;
}

export type MfeEventName = keyof MfeEventMap;

const BASE = { bubbles: true, composed: true } as const;

/**
 * Offer `href` to the host from `source`. True when the host took it — the
 * producer then cancels its own click.
 */
export function dispatchNavigate(source: EventTarget, href: string): boolean {
  const event = new CustomEvent<NavigateDetail>(NAVIGATE_EVENT, {
    ...BASE,
    cancelable: true,
    detail: { href },
  });
  return !source.dispatchEvent(event);
}

/** Producer side: report {@link SIGNED_IN_EVENT} from `source`. */
export function dispatchSignedIn(source: EventTarget): void {
  source.dispatchEvent(new CustomEvent<null>(SIGNED_IN_EVENT, { ...BASE, detail: null }));
}

/** Producer side: report {@link SIGNOUT_EVENT} from `source`. */
export function dispatchSignOut(source: EventTarget): void {
  source.dispatchEvent(new CustomEvent<null>(SIGNOUT_EVENT, { ...BASE, detail: null }));
}

/** Producer side: contribute `binding` to the host's keymap from `source`, until `signal` aborts. */
export function dispatchKeymap(source: EventTarget, binding: ElementBinding, signal: AbortSignal): void {
  source.dispatchEvent(new CustomEvent<KeymapDetail>(KEYMAP_EVENT, { ...BASE, detail: { binding, signal } }));
}

/** Producer side: hand the host's undo history an entry for a change just made. */
export function dispatchUndo(source: EventTarget, entry: UndoEntry): void {
  source.dispatchEvent(new CustomEvent<UndoEntry>(UNDO_EVENT, { ...BASE, detail: entry }));
}

// `detail` comes from a bundle the host does not build: a malformed one throws, naming the element.
function detailOf(event: Event): { detail: object; who: string } {
  const target = event.target as Partial<Element> | null;
  const who = `<${target?.localName ?? 'unknown'}>'s ${event.type}`;
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (typeof detail !== 'object' || detail === null) throw new Error(`${who} carries no detail`);
  return { detail, who };
}

function chordOf(raw: unknown, who: string): Chord {
  if (typeof raw !== 'object' || raw === null || typeof Reflect.get(raw, 'key') !== 'string') throw new Error(`${who}: a chord is { key, ctrl?, alt?, meta? }`);
  for (const flag of ['ctrl', 'alt', 'meta']) {
    const v: unknown = Reflect.get(raw, flag);
    if (v !== undefined && typeof v !== 'boolean') throw new Error(`${who}: a chord's ${flag} is a boolean`);
  }
  return raw as Chord;
}

function bindingOf(raw: unknown, who: string): ElementBinding {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${who}: a binding is an object`);
  const on: unknown = Reflect.get(raw, 'on');
  if (typeof on === 'object' && on !== null && 'other' in on) {
    chordOf(Reflect.get(on, 'other'), who);
    chordOf(Reflect.get(on, 'mac'), who);
  } else chordOf(on, who);
  const run: unknown = Reflect.get(raw, 'run');
  if (run !== undefined) {
    const id: unknown = Reflect.get(raw, 'id');
    if (typeof id !== 'string' || id === '') throw new Error(`${who}: a leaf has an id`);
    if (typeof run !== 'object' || run === null || typeof Reflect.get(run, 'label') !== 'string' || typeof Reflect.get(run, 'run') !== 'function')
      throw new Error(`${who}: a leaf runs { label, run }`);
    return { on: on as Chord | Trigger, id, run: run as ElementLeaf };
  }
  const label: unknown = Reflect.get(raw, 'label');
  const children: unknown = Reflect.get(raw, 'children');
  if (typeof label !== 'string' || !Array.isArray(children)) throw new Error(`${who}: a binding is a leaf { on, id, run } or a scope { on, label, children }`);
  return { on: on as Chord | Trigger, label, children: children.map(c => bindingOf(c, who)) };
}

/** Host side: the `detail` of an {@link KEYMAP_EVENT}, read as untrusted. Throws on a malformed one. */
export function keymapDetail(event: Event): KeymapDetail {
  const { detail, who } = detailOf(event);
  const signal: unknown = Reflect.get(detail, 'signal');
  if (!(signal instanceof AbortSignal)) throw new Error(`${who}: signal is an AbortSignal`);
  return { binding: bindingOf(Reflect.get(detail, 'binding'), who), signal };
}

/** Host side: the entry an {@link UNDO_EVENT} carries, read as untrusted. Throws on a malformed one. */
export function undoEntry(event: Event): UndoEntry {
  const { detail, who } = detailOf(event);
  const [label, undo, redo]: unknown[] = ['label', 'undo', 'redo'].map(k => Reflect.get(detail, k));
  if (typeof label !== 'string' || typeof undo !== 'function' || typeof redo !== 'function') throw new Error(`${who}: an entry is { label, undo, redo }`);
  return { label, undo: undo as UndoEntry['undo'], redo: redo as UndoEntry['redo'] };
}

/**
 * The `href` of an `ev:navigate` event, or null when the detail is missing or
 * malformed. `detail` comes from a bundle the host does not build — read it as
 * untrusted. Only root-relative paths pass: a host router cannot route
 * anything else, and `//evil` or `/\evil` would leave the origin.
 */
export function navigateHref(event: Event): string | null {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (typeof detail !== 'object' || detail === null) return null;
  return rootRelative(Reflect.get(detail, 'href'));
}

/**
 * `raw` if it is a path on the current origin, else null. Browsers strip tabs
 * and newlines and read `\` as `/`, so `//evil`, `/\evil` and `/<TAB>/evil`
 * would all leave the origin; they are refused with every control character.
 * The one rule for anything a host routes or redirects to: `ev:navigate`
 * destinations and RP-login `return_to` alike.
 */
export function rootRelative(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/[\u0000-\u001F\u007F\\]/.test(raw)) return null;
  return raw;
}

/** The parts of a click {@link delegatedHref} reads (DOM `MouseEvent` or React's wrapper). */
export interface LinkClick {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** The parts of the clicked `<a>` {@link delegatedHref} reads. */
export interface LinkAnchor {
  href: string;
  target: string;
  hasAttribute(name: string): boolean;
}

/**
 * Producer side: the path to offer the host for a link click, or null when the
 * click is the browser's — modified or non-primary (new tab, download), a
 * `target`/`download` link, already handled, or another origin, which no host
 * router can reach. Also the browser's: an `<a>` with no href (the DOM reports
 * `""`), which navigates nowhere, and an in-page `#fragment` link, which only
 * scrolls — a router push there would re-render the page instead. Enter on a
 * focused link arrives as a `button` 0 click.
 */
export function delegatedHref(
  click: LinkClick,
  anchor: LinkAnchor,
  page: { href: string; origin: string },
): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return null;
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null;
  if (anchor.href === '') return null;
  let url: URL;
  let here: URL;
  try {
    url = new URL(anchor.href, page.href);
    here = new URL(page.href);
  } catch {
    return null;
  }
  if (url.origin !== page.origin) return null;
  if (url.hash !== '' && url.pathname === here.pathname && url.search === here.search) return null;
  return url.pathname + url.search + url.hash;
}
