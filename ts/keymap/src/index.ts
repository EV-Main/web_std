// The TS twin of `ev_lib::keymap` (rust/src/ui/keymap.rs), pinned by tests/fixtures/keymap/.

import type { HelpRow, Hint, HintRow, Platform } from "./generated/view";

export type { HelpRow, Hint, HintRow, Platform } from "./generated/view";
export { PLATFORMS } from "./generated/view";

/** One keydown to match. `key` is a printable ASCII char whose case carries Shift (`"u"`, `"U"`, `"?"`), or a named key (`"Backspace"`). */
export interface Chord {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** What fires a binding, per platform: macOS takes Cmd where others take Ctrl. */
export interface Trigger {
  other: Chord;
  mac: Chord;
}

/** A leaf runs its command; a scope opens its children. */
export type Binding<C> = { on: Chord | Trigger } & ({ run: C } | { label: string; children: readonly Binding<C>[] });

/** Every chord the page claims without a scope open. A leader is a root scope. */
export interface Keymap<C> {
  root: readonly Binding<C>[];
}

/** A raw keydown, before normalization: the DOM `KeyboardEvent` fields of the same names. */
export interface KeyInput {
  key: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
  repeat: boolean;
  /** An IME composition is under way: the key belongs to it. */
  composing: boolean;
  /** The event's innermost target takes text, so a root leaf leaves it its typing and undo. */
  editable: boolean;
}

export function keyInput(e: KeyboardEvent): KeyInput {
  // `composedPath()[0]`, not `target`: on `window`, an `<input>` inside a shadow root reports as its host element.
  // `nodeType`, not `instanceof`: a same-origin frame's elements are of another realm.
  const target = e.composedPath()[0] as Partial<HTMLElement> | undefined;
  const editable =
    target?.nodeType === 1 && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName!) || target.isContentEditable === true);
  return {
    key: e.key,
    code: e.code,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
    shift: e.shiftKey,
    repeat: e.repeat,
    composing: e.isComposing,
    editable,
  };
}

/** `navigator.platform`. iPadOS reports `MacIntel`. */
export function platformOf(navigatorPlatform: string): Platform {
  return ["Mac", "iPhone", "iPad", "iPod"].some(p => navigatorPlatform.includes(p)) ? "mac" : "other";
}

export function currentPlatform(): Platform {
  return platformOf(navigator.platform);
}

const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Fn"];

/** Whether a `key` names one a binding could mean: not a modifier, nor a key the layout couldn't say. */
function isKey(key: string): boolean {
  if (key.length === 1) return key >= " " && key <= "~";
  return /^[A-Za-z0-9]+$/.test(key) && !MODIFIERS.includes(key) && !["Dead", "Unidentified", "Process"].includes(key);
}

/**
 * The `Chord.key` this keydown is, or `undefined` for one no binding can mean (a lone modifier).
 * The printable ASCII `key` the layout produced; else a named key; else the Latin label of the
 * physical key (`KeyS`), so ЙЦУКЕН and macOS Option chords reach the letter printed on the key.
 * Letter case comes from Shift alone, so CapsLock is ignored.
 */
export function normalized(k: KeyInput): string | undefined {
  const cased = (c: string) => (k.shift ? c.toUpperCase() : c.toLowerCase());
  if (isKey(k.key)) return k.key.length === 1 ? cased(k.key) : k.key;
  if (MODIFIERS.includes(k.key)) return undefined;
  const label = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(k.code);
  return label === null ? undefined : cased(label[1] ?? label[2]!);
}

/** Where a keydown went. */
export type Step<C> =
  /** Not ours: the key goes on to the page. `cancelled` when it dropped an open scope. */
  | { kind: "pass"; cancelled: boolean }
  /** A scope opened, or re-opened from the root. */
  | { kind: "opened" }
  /** Esc closed the open scope. */
  | { kind: "closed" }
  /** A held key reached a leaf: kept from the browser, and nothing runs again. */
  | { kind: "held" }
  /** The leaf reached, and the sequence that reached it. */
  | { kind: "run"; command: C; sequence: string };

function pick(on: Chord | Trigger, platform: Platform): Chord {
  return "other" in on ? (platform === "mac" ? on.mac : on.other) : on;
}

function renderChord(c: Chord, platform: Platform): string {
  const letter = /^[A-Za-z]$/.test(c.key);
  const shift = letter && c.key === c.key.toUpperCase();
  const key = letter ? c.key.toUpperCase() : c.key === " " ? "Space" : c.key;
  const mods: [boolean | undefined, string, string][] = [
    [c.ctrl, "Ctrl+", "⌃"],
    [c.alt, "Alt+", "⌥"],
    [shift, "Shift+", "⇧"],
    [c.meta, "Meta+", "⌘"],
  ];
  return mods.map(([on, other, mac]) => (on ? (platform === "mac" ? mac : other) : "")).join("") + key;
}

/** As its keycaps read: `Ctrl+Shift+K` elsewhere, `⇧⌘K` on macOS. */
export function render(on: Chord | Trigger, platform: Platform): string {
  return renderChord(pick(on, platform), platform);
}

type Item<C> = { label: string } & ({ run: C } | { children: Level<C> });
type Level<C> = [Chord, Item<C>][];

const same = (a: Chord, b: Chord) => a.key === b.key && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.meta === !!b.meta;

/** A `Keymap` resolved for one platform, and the path a chord has opened into it. */
export class Trie<C> {
  readonly #root: Level<C>;
  readonly #platform: Platform;
  #pending: number[] = [];

  /** A command `available` rejects is unbound; a scope left with nothing in it, too. `label` names a command. */
  constructor(keymap: Keymap<C>, platform: Platform, available: (c: C) => boolean, label: (c: C) => string) {
    const level = (bs: readonly Binding<C>[]): Level<C> => {
      bs.forEach((b, i) => {
        const c = pick(b.on, platform);
        if (!isKey(c.key)) throw new Error(`${JSON.stringify(c)} names no key a keydown normalizes to`);
        if (bs.slice(0, i).some(o => same(pick(o.on, platform), c))) throw new Error(`${JSON.stringify(c)} is bound twice in one scope`);
      });
      return bs.flatMap((b): Level<C> => {
        if ("run" in b) return available(b.run) ? [[pick(b.on, platform), { label: label(b.run), run: b.run }]] : [];
        const children = level(b.children);
        return children.length === 0 ? [] : [[pick(b.on, platform), { label: b.label, children }]];
      });
    };
    this.#root = level(keymap.root);
    this.#platform = platform;
  }

  #at(path: readonly number[]): Level<C> {
    return path.reduce((l, i) => {
      const item = l[i]![1];
      if (!("children" in item)) throw new Error("a pending path only ever descends into scopes");
      return item.children;
    }, this.#root);
  }

  /** One keydown. A miss drops the open scope, a lone modifier doesn't; a root scope's chord pressed inside another (a key-repeating leader) restarts at that scope instead. A modified leader and an open scope's keys act from an editable; a root leaf or an unmodified root chord leaves it its typing and undo. */
  key(k: KeyInput): Step<C> {
    const open = this.#pending.length > 0;
    if (k.composing) {
      this.#pending = [];
      return { kind: "pass", cancelled: open };
    }
    if (MODIFIERS.includes(k.key)) return { kind: "pass", cancelled: false };
    const key = normalized(k);
    if (key === undefined) {
      this.#pending = [];
      return { kind: "pass", cancelled: open };
    }
    if (open && key === "Escape") {
      this.#pending = [];
      return { kind: "closed" };
    }
    const hit = (l: Level<C>) => l.findIndex(([c]) => same(c, { key, ctrl: k.ctrl, alt: k.alt, meta: k.meta }));
    let i = hit(this.#at(this.#pending));
    if (i < 0) {
      const r = hit(this.#root);
      this.#pending = [];
      if (!(open && r >= 0 && "children" in this.#root[r]![1])) return { kind: "pass", cancelled: open };
      i = r;
    }
    const parent = this.#at(this.#pending);
    // At root a field keeps its typing (an unmodified chord, a leader's too) and its undo (a leaf).
    if (this.#pending.length === 0 && k.editable && ("run" in parent[i]![1] || !(k.ctrl || k.alt || k.meta))) return { kind: "pass", cancelled: open };
    this.#pending.push(i);
    const sequence = this.#sequence(this.#pending);
    const item = parent[i]![1];
    if ("children" in item) return { kind: "opened" };
    this.#pending = [];
    return k.repeat ? { kind: "held" } : { kind: "run", command: item.run, sequence };
  }

  /** Drop the open scope (the window lost focus, a press moved on). Whether one was open. */
  cancel(): boolean {
    const open = this.#pending.length > 0;
    this.#pending = [];
    return open;
  }

  #sequence(path: readonly number[]): string {
    const out: string[] = [];
    let l = this.#root;
    for (const i of path) {
      const [c, item] = l[i]!;
      out.push(renderChord(c, this.#platform));
      if ("children" in item) l = item.children;
    }
    return out.join(" ");
  }

  /** The open scope's hint; `undefined` while none is open. */
  hint(): Hint | undefined {
    if (this.#pending.length === 0) return undefined;
    const rows: HintRow[] = this.#at(this.#pending).map(([c, item]) => ({ chord: renderChord(c, this.#platform), label: item.label, scope: "children" in item }));
    return { prefix: this.#sequence(this.#pending), rows };
  }

  /** Every bound leaf, depth-first. */
  help(): HelpRow[] {
    const out: HelpRow[] = [];
    const walk = (l: Level<C>, prefix: string) => {
      for (const [c, item] of l) {
        const chord = renderChord(c, this.#platform);
        const sequence = prefix === "" ? chord : `${prefix} ${chord}`;
        if ("children" in item) walk(item.children, sequence);
        else out.push({ sequence, label: item.label });
      }
    };
    walk(this.#root, "");
    return out;
  }
}
