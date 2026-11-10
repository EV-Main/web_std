import { dispatchUndo } from "@evinvest/mfe";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { KeymapProvider } from "../src/components/shell/keymap";
import { UndoProvider, type UndoEntry, useUndo } from "../src/components/shell/undo";

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
};
const undoKey = (target?: EventTarget) => press({ key: "z", code: "KeyZ", ctrlKey: true }, target);
const redoKey = () => press({ key: "y", code: "KeyY", ctrlKey: true });
const settle = () => act(async () => {});

// A value the page holds, set through entries that refuse once it is not what they left.
function counter() {
  const log: string[] = [];
  let value = 0;
  const set = (label: string, to: number): UndoEntry => {
    const before = value;
    value = to;
    return {
      label,
      undo: async () => {
        if (value !== to) throw new Error(`${label}: changed since`);
        value = before;
        log.push(`undo ${label}`);
      },
      redo: async () => {
        if (value !== before) throw new Error(`${label}: changed since`);
        value = to;
        log.push(`redo ${label}`);
      },
    };
  };
  return { log, set, poke: (to: number) => (value = to), get: () => value };
}

let push: (e: UndoEntry) => void;
function Grab() {
  push = useUndo();
  return null;
}
const page = () =>
  render(
    <KeymapProvider leader={{ key: "s", alt: true }}>
      <UndoProvider labels={{ undo: "Undo", redo: "Redo" }}>
        <Grab />
        <textarea />
      </UndoProvider>
    </KeymapProvider>,
  );

describe("UndoProvider", () => {
  it("undoes and redoes in order, a field keeping its own undo; nothing to undo leaves the key to the browser", async () => {
    page();
    const c = counter();
    expect(undoKey().defaultPrevented).toBe(false);
    act(() => push(c.set("a", 1)));
    act(() => push(c.set("b", 2)));
    expect(undoKey(screen.getByRole("textbox")).defaultPrevented).toBe(false);
    expect(undoKey().defaultPrevented).toBe(true);
    undoKey();
    await settle();
    expect(c.log).toEqual(["undo b", "undo a"]);
    expect(c.get()).toBe(0);
    expect(undoKey().defaultPrevented).toBe(false);
    redoKey();
    await settle();
    expect(c.get()).toBe(1);
    act(() => push(c.set("c", 5)));
    expect(redoKey().defaultPrevented).toBe(false);
  });

  it("drops the whole history when an entry refuses: the state is no longer what it left", async () => {
    page();
    const c = counter();
    act(() => push(c.set("a", 1)));
    act(() => push(c.set("b", 2)));
    c.poke(7);
    undoKey();
    await settle();
    expect(c.get()).toBe(7);
    expect(undoKey().defaultPrevented).toBe(false);
    expect(redoKey().defaultPrevented).toBe(false);
  });

  it("takes an element's entries through ev:undo", async () => {
    page();
    const c = counter();
    const element = document.body.appendChild(document.createElement("mfe-x"));
    act(() => dispatchUndo(element, c.set("a", 1)));
    undoKey();
    await settle();
    expect(c.log).toEqual(["undo a"]);
    element.remove();
  });
});
