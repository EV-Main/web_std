"use client";

import { UNDO_EVENT, type UndoEntry, undoEntry } from "@evinvest/mfe";
import * as React from "react";
import { toast } from "../atomic/sonner";
import { useBinding } from "./keymap";

export type { UndoEntry } from "@evinvest/mfe";

export interface UndoLabels {
  undo: string;
  redo: string;
}

const PushContext = React.createContext<((entry: UndoEntry) => void) | null>(null);

/**
 * The page's one undo history: a linear stack the page's features push to with `useUndo` and its
 * hosted elements with `ev:undo` (`@evinvest/mfe`). Ctrl+Z / ⌘Z undoes, Ctrl+Shift+Z / ⇧⌘Z and
 * Ctrl+Y redo — root leaves, so a field keeps its own text undo. Entries run one at a time, in the
 * order pressed; one that rejects drops the whole history, as it no longer describes the page.
 * Sits inside a `KeymapProvider`.
 */
export function UndoProvider({ labels, children }: { labels: UndoLabels; children: React.ReactNode }) {
  const done = React.useRef<UndoEntry[]>([]);
  const undone = React.useRef<UndoEntry[]>([]);
  const queue = React.useRef(Promise.resolve());
  const [depth, setDepth] = React.useState({ done: 0, undone: 0 });
  const sync = React.useCallback(() => setDepth({ done: done.current.length, undone: undone.current.length }), []);

  const push = React.useCallback(
    (entry: UndoEntry) => {
      done.current.push(entry);
      undone.current = [];
      sync();
    },
    [sync],
  );

  // Moved at the press, run in its turn: a second press goes to the entry the first one left.
  const travel = (back: boolean) => {
    const [from, to] = back ? [done.current, undone.current] : [undone.current, done.current];
    const entry = from.pop()!;
    to.push(entry);
    sync();
    queue.current = queue.current.then(async () => {
      try {
        await (back ? entry.undo() : entry.redo());
        toast(`${back ? labels.undo : labels.redo}: ${entry.label}`);
      } catch (e) {
        done.current = [];
        undone.current = [];
        sync();
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const undo = depth.done > 0 ? () => travel(true) : null;
  const redo = depth.undone > 0 ? () => travel(false) : null;
  useBinding({ on: { other: { key: "z", ctrl: true }, mac: { key: "z", meta: true } }, run: { label: labels.undo, run: undo } }, "root");
  useBinding({ on: { other: { key: "Z", ctrl: true }, mac: { key: "Z", meta: true } }, run: { label: labels.redo, run: redo } }, "root");
  useBinding({ on: { key: "y", ctrl: true }, run: { label: labels.redo, run: redo } }, "root");

  React.useEffect(() => {
    const onUndo = (e: Event) => push(undoEntry(e));
    window.addEventListener(UNDO_EVENT, onUndo);
    return () => window.removeEventListener(UNDO_EVENT, onUndo);
  }, [push]);

  return <PushContext.Provider value={push}>{children}</PushContext.Provider>;
}

/** Hand the page's undo history an entry for a change just made. A new entry drops what was undone. */
export function useUndo(): (entry: UndoEntry) => void {
  const push = React.useContext(PushContext);
  if (push === null) throw new Error("useUndo needs an <UndoProvider> above it");
  return push;
}
