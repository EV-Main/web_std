"use client";

import { type Binding, type Chord, type HelpRow, type Hint, type KeyInput, type Keymap, type Platform, type Trigger, Trie, currentPlatform, keyInput } from "@evinvest/keymap";
import { type ElementBinding, KEYMAP_EVENT, keymapDetail } from "@evinvest/mfe";
import * as React from "react";
import { KEY_HELP_LABELS } from "../../generated/key-help";
import { KeyHelp, type KeyHelpLabels } from "./key-help";
import { KeyHint } from "./key-hint";

/** What a key runs. `run: null` leaves it unbound: absent from the hint and the help. */
export interface Leaf {
  label: string;
  run: (() => void) | null;
}

export type KeyBinding = Binding<Leaf>;

/** Under the leader, or claimed globally without it. */
export type Where = "leader" | "root";

interface Registration {
  key: number;
  where: Where;
  latest: () => KeyBinding;
}

/** Where a hosted element's keys sit: a scope under the leader. */
export interface ElementScope {
  on: Chord | Trigger;
  label: string;
}

interface Contribution {
  key: number;
  element: Element;
  binding: ElementBinding;
}

// An element's leaf is bound while the element is connected: a Dioxus one keeps running detached.
type Bound = Leaf & { from?: Element };

interface Built {
  trie: Trie<Bound>;
  connected: ReadonlyMap<Element, boolean>;
}

/** What is bound now, by leaf id (an element's as `<tag>/<id>`), and running one as its keys would. */
export interface PageKeymap {
  bound: ReadonlyMap<string, HelpRow>;
  /** Throws on an id not bound now. */
  run: (id: string) => void;
}

interface Registry {
  add: (where: Where, latest: () => KeyBinding) => () => void;
  keymap: PageKeymap;
}

const RegistryContext = React.createContext<Registry | null>(null);

function useRegistry(hook: string): Registry {
  const registry = React.useContext(RegistryContext);
  if (registry === null) throw new Error(`${hook} needs a <KeymapProvider> above it`);
  return registry;
}

/** The platform's keycaps, read after mount so the server render and the first client render agree. */
export function usePlatform(): Platform {
  const [platform, setPlatform] = React.useState<Platform>("other");
  React.useEffect(() => setPlatform(currentPlatform()), []);
  return platform;
}

// A leaf runs whatever its registration holds when the key lands, not what it held when the trie was built.
function live(b: KeyBinding, latest: () => KeyBinding, path: readonly number[]): KeyBinding {
  if ("run" in b) {
    const run = () => {
      const now = path.reduce<KeyBinding>((at, i) => ("children" in at ? at.children[i]! : at), latest());
      if (!("run" in now) || now.run.run === null) throw new Error("a bound leaf changed shape without re-registering");
      now.run.run();
    };
    return { on: b.on, id: b.id, run: { ...b.run, run: b.run.run && run } };
  }
  return { on: b.on, label: b.label, children: b.children.map((c, i) => live(c, latest, [...path, i])) };
}

// The structure a trie is built from: everything but the closures, which `live` reads late.
const shapeOf = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "function" ? true : x));

export interface KeymapProviderProps {
  /** Opens the scope every `useBinding(…, "leader")` contributes to. */
  leader: Chord | Trigger;
  /** By tag: the scope under the leader a hosted element's `ev:keymap` bindings sit in. An element with none assigned is refused. */
  elements?: Readonly<Record<string, ElementScope>>;
  labels?: KeyHelpLabels;
  children: React.ReactNode;
}

/**
 * The page's keymap, heard ahead of the page's own handlers and a focused same-origin frame's: the
 * leader's scope with a `?` help in it, and the which-key hint for whatever scope is open. Features
 * contribute with `useBinding` while mounted, hosted elements with `ev:keymap` (`@evinvest/mfe`).
 */
export function KeymapProvider({ leader, elements = {}, labels = {}, children }: KeymapProviderProps) {
  const [registrations, setRegistrations] = React.useState<readonly Registration[]>([]);
  const next = React.useRef(0);
  const add = React.useCallback((where: Where, latest: () => KeyBinding) => {
    const key = next.current++;
    setRegistrations(rs => [...rs, { key, where, latest }]);
    return () => setRegistrations(rs => rs.filter(r => r.key !== key));
  }, []);

  const platform = usePlatform();
  const [help, setHelp] = React.useState(false);
  const [hint, setHint] = React.useState<Hint>();
  const title = labels.title ?? KEY_HELP_LABELS.title;
  const leaderShape = shapeOf(leader);

  const scopesShape = shapeOf(elements);
  const [contributions, setContributions] = React.useState<readonly Contribution[]>([]);
  React.useEffect(() => {
    const scopes = JSON.parse(scopesShape) as Record<string, ElementScope>;
    const onKeymap = (e: Event) => {
      const { binding, signal } = keymapDetail(e);
      const element = e.composedPath().find((n): n is Element => (n as Partial<Element>).nodeType === 1 && Object.hasOwn(scopes, (n as Element).localName));
      if (element === undefined) throw new Error(`<${(e.target as Element).localName}> contributes keys, but its host assigns it no scope`);
      if (signal.aborted) return;
      const key = next.current++;
      setContributions(cs => [...cs, { key, element, binding }]);
      signal.addEventListener("abort", () => setContributions(cs => cs.filter(c => c.key !== key)), { once: true });
    };
    window.addEventListener(KEYMAP_EVENT, onKeymap);
    return () => window.removeEventListener(KEYMAP_EVENT, onKeymap);
  }, [scopesShape]);

  const keymap = React.useMemo((): Keymap<Bound> => {
    const from = (where: Where) => registrations.filter(r => r.where === where).map(r => live(r.latest(), r.latest, []));
    const scopes = JSON.parse(scopesShape) as Record<string, ElementScope>;
    const fromElement = (b: ElementBinding, element: Element): Binding<Bound> =>
      "run" in b
        ? { on: b.on, id: `${element.localName}/${b.id}`, run: { ...b.run, from: element } }
        : { on: b.on, label: b.label, children: b.children.map(c => fromElement(c, element)) };
    const byElement = new Map<Element, Binding<Bound>[]>();
    for (const c of contributions) byElement.set(c.element, [...(byElement.get(c.element) ?? []), fromElement(c.binding, c.element)]);
    const hosted = [...byElement].map(([element, children]): Binding<Bound> => ({ ...scopes[element.localName]!, children }));
    const keybinds: KeyBinding = { on: { key: "?" }, id: "key-help", run: { label: title, run: () => setHelp(true) } };
    return { root: [{ on: JSON.parse(leaderShape) as Chord | Trigger, label: "leader", children: [...from("leader"), ...hosted, keybinds] }, ...from("root")] };
  }, [registrations, contributions, leaderShape, scopesShape, title]);
  const build = React.useCallback((): Built => {
    const connected = new Map(contributions.map(c => [c.element, c.element.isConnected]));
    return { trie: new Trie(keymap, platform, leaf => leaf.run !== null && (leaf.from === undefined || connected.get(leaf.from)!), leaf => leaf.label), connected };
  }, [keymap, platform, contributions]);
  const built = React.useMemo(build, [build]);

  const current = React.useRef(built);
  const rebuild = React.useRef(build);
  React.useEffect(() => {
    current.current = built;
    rebuild.current = build;
    setHint(undefined);
  }, [built, build]);
  // Connecting or leaving fires nothing here, so a hosted element's keys are re-read before a sequence starts.
  const fresh = React.useCallback(() => {
    if (current.current.trie.hint() === undefined && [...current.current.connected].some(([el, was]) => el.isConnected !== was)) current.current = rebuild.current();
    return current.current.trie;
  }, []);

  React.useEffect(() => {
    const step = (k: KeyInput, e: KeyboardEvent) => {
      const trie = fresh();
      const step = trie.key(k);
      if (step.kind === "pass") {
        if (step.cancelled) setHint(undefined);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setHint(trie.hint());
      if (step.kind === "run") step.command.run!();
    };
    const onKey = (e: KeyboardEvent) => step(keyInput(e), e);
    // A frame's app keeps its root chords, as a field does.
    const onFrameKey = (e: KeyboardEvent) => step({ ...keyInput(e), editable: true }, e);
    // A frame's keys never reach its parent's window; a same-origin one is heard while it holds focus, a cross-origin one can't be.
    // Keyed by document: a frame that navigates drops its listeners with it, and is attached again on the next blur.
    const frames = new Map<Document, () => void>();
    const follow = (doc: Document) => {
      if (current.current.trie.cancel()) setHint(undefined);
      let at = doc.activeElement;
      while (at?.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
      // `tagName`, not `instanceof`: a nested frame's element is of its parent frame's realm.
      const inner = at?.tagName === "IFRAME" ? (at as HTMLIFrameElement).contentDocument : null;
      if (inner === null || frames.has(inner)) return;
      const w = inner.defaultView!;
      const onBlur = () => follow(inner);
      w.addEventListener("keydown", onFrameKey, true);
      w.addEventListener("blur", onBlur);
      frames.set(inner, () => {
        w.removeEventListener("keydown", onFrameKey, true);
        w.removeEventListener("blur", onBlur);
      });
    };
    const onBlur = () => follow(document);
    const leaveFrames = () => {
      for (const detach of frames.values()) detach();
      frames.clear();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", leaveFrames);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", leaveFrames);
      leaveFrames();
    };
  }, [fresh]);

  const run = React.useCallback(
    (id: string) => {
      if (current.current.trie.cancel()) setHint(undefined);
      const command = fresh().command(id);
      if (command === undefined) throw new Error(`no key runs "${id}" now`);
      command.run!();
    },
    [fresh],
  );
  const bound = React.useMemo(() => new Map(built.trie.help().map(row => [row.id, row])), [built]);
  const registry = React.useMemo(() => ({ add, keymap: { bound, run } }), [add, bound, run]);
  return (
    <RegistryContext.Provider value={registry}>
      {children}
      {hint && <KeyHint hint={hint} />}
      <KeyHelp rows={help ? current.current.trie.help() : []} open={help} onOpenChange={setHelp} labels={{ title }} />
    </RegistryContext.Provider>
  );
}

/** Contribute `binding` to the page's keymap while the calling component is mounted. */
export function useBinding(binding: KeyBinding, where: Where = "leader"): void {
  const { add } = useRegistry("useBinding");
  const latest = React.useRef(binding);
  React.useEffect(() => {
    latest.current = binding;
  });
  const shape = shapeOf(binding);
  React.useEffect(() => add(where, () => latest.current), [add, where, shape]);
}

/** The page's keymap, for whatever reaches it without keys: a control showing its keycaps, an agent. */
export function useKeymap(): PageKeymap {
  return useRegistry("useKeymap").keymap;
}
