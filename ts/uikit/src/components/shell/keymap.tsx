"use client";

import { type Binding, type Chord, type Hint, type Keymap, type Platform, type Trigger, Trie, currentPlatform, keyInput, render } from "@evinvest/keymap";
import * as React from "react";
import { KEY_HELP_LABELS } from "../../generated/key-help";
import { KeyHelp, type KeyHelpLabels } from "./key-help";
import { KeyHint } from "./key-hint";

/** What a key runs. `run: null` leaves it unbound: absent from the hint and the help. `id` names it to whatever shows its keys (a `HotbarAction.binding`). */
export interface Leaf {
  id?: string;
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

interface Registry {
  add: (where: Where, latest: () => KeyBinding) => () => void;
  sequences: ReadonlyMap<string, string>;
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
    return { on: b.on, run: { ...b.run, run: b.run.run && run } };
  }
  return { on: b.on, label: b.label, children: b.children.map((c, i) => live(c, latest, [...path, i])) };
}

// The structure a trie is built from: everything but the closures, which `live` reads late.
const shapeOf = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "function" ? true : x));

export interface KeymapProviderProps {
  /** Opens the scope every `useBinding(…, "leader")` contributes to. */
  leader: Chord | Trigger;
  labels?: KeyHelpLabels;
  children: React.ReactNode;
}

/**
 * The page's keymap, heard ahead of the page's own handlers and a focused same-origin frame's: the
 * leader's scope with a `?` help in it, and the which-key hint for whatever scope is open. Features
 * contribute with `useBinding` while mounted.
 */
export function KeymapProvider({ leader, labels = {}, children }: KeymapProviderProps) {
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

  const keymap = React.useMemo((): Keymap<Leaf> => {
    const from = (where: Where) => registrations.filter(r => r.where === where).map(r => live(r.latest(), r.latest, []));
    const keybinds: KeyBinding = { on: { key: "?" }, run: { label: title, run: () => setHelp(true) } };
    return { root: [{ on: JSON.parse(leaderShape) as Chord | Trigger, label: "leader", children: [...from("leader"), keybinds] }, ...from("root")] };
  }, [registrations, leaderShape, title]);
  const trie = React.useMemo(() => new Trie(keymap, platform, leaf => leaf.run !== null, leaf => leaf.label), [keymap, platform]);

  React.useEffect(() => {
    setHint(undefined);
    const onKey = (e: KeyboardEvent) => {
      const step = trie.key(keyInput(e));
      if (step.kind === "pass") {
        if (step.cancelled) setHint(undefined);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setHint(trie.hint());
      if (step.kind === "run") step.command.run!();
    };
    // A frame's keys never reach this window; a same-origin one is heard while it holds focus, a cross-origin one can't be.
    let framed: Window | null = null;
    const leaveFrame = () => {
      framed?.removeEventListener("keydown", onKey, true);
      framed = null;
    };
    const onBlur = () => {
      if (trie.cancel()) setHint(undefined);
      leaveFrame();
      let at = document.activeElement;
      while (at?.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
      if (at instanceof HTMLIFrameElement && at.contentDocument !== null) {
        framed = at.contentWindow!;
        framed.addEventListener("keydown", onKey, true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", leaveFrame);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", leaveFrame);
      leaveFrame();
    };
  }, [trie]);

  const sequences = React.useMemo(() => {
    const out = new Map<string, string>();
    const walk = (bs: readonly KeyBinding[], prefix: string) => {
      for (const b of bs) {
        const seq = prefix === "" ? render(b.on, platform) : `${prefix} ${render(b.on, platform)}`;
        if ("children" in b) walk(b.children, seq);
        else if (b.run.id !== undefined && b.run.run !== null) out.set(b.run.id, seq);
      }
    };
    walk(keymap.root, "");
    return out;
  }, [keymap, platform]);

  const registry = React.useMemo(() => ({ add, sequences }), [add, sequences]);
  return (
    <RegistryContext.Provider value={registry}>
      {children}
      {hint && <KeyHint hint={hint} />}
      <KeyHelp rows={help ? trie.help() : []} open={help} onOpenChange={setHelp} labels={{ title }} />
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

/** The keys that reach each bound leaf with an `id`, as its keycaps read. */
export function useSequences(): ReadonlyMap<string, string> {
  return useRegistry("useSequences").sequences;
}
