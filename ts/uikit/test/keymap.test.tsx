import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { dispatchKeymap } from "@evinvest/mfe";
import { KeymapProvider, type Leaf, useBinding } from "../src/components/shell/keymap";

function Bind({ on, label, run, where }: { on: string; label: string; run: Leaf["run"]; where?: "leader" | "root" }) {
  useBinding({ on: { key: on }, run: { label, run } }, where);
  return null;
}

function Go({ home }: { home: () => void }) {
  useBinding({ on: { key: "g" }, label: "go", children: [{ on: { key: "h" }, run: { label: "Home", run: home } }] });
  return null;
}

const press = (init: KeyboardEventInit, target: EventTarget = document.body, realm: typeof globalThis = globalThis) => {
  const e = new realm.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
};
const focusFrame = (frame: HTMLIFrameElement, from: Window) =>
  act(() => {
    frame.focus();
    from.dispatchEvent(new FocusEvent("blur"));
  });
const pressInto = (w: Window & typeof globalThis) => (init: KeyboardEventInit) => press(init, w.document.body, w);
const leader = () => press({ key: "s", code: "KeyS", altKey: true });
const hint = () => document.querySelector('[data-slot="key-hint"]');

describe("KeymapProvider", () => {
  it("opens the leader's hint, runs a leaf, and keeps the browser from both keys", () => {
    const run = vi.fn();
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={run} />
      </KeymapProvider>,
    );
    expect(leader().defaultPrevented).toBe(true);
    expect(hint()).toHaveTextContent("Alt+S");
    expect(hint()).toHaveTextContent("Assistant");
    expect(press({ key: "a", code: "KeyA" }).defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(hint()).toBeNull();
    press({ key: "a", code: "KeyA" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reaches the leader on a Russian layout, and a nested scope", () => {
    const home = vi.fn();
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Go home={home} />
      </KeymapProvider>,
    );
    press({ key: "ы", code: "KeyS", altKey: true });
    press({ key: "п", code: "KeyG" });
    expect(hint()).toHaveTextContent("Alt+S G");
    press({ key: "р", code: "KeyH" });
    expect(home).toHaveBeenCalledTimes(1);
  });

  it("opens the leader from a field and keeps its next key from it; a root leaf stays the field's", () => {
    const run = vi.fn();
    const undo = vi.fn();
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={run} />
        <Bind on="Z" label="Undo" run={undo} where="root" />
        <textarea />
      </KeymapProvider>,
    );
    const field = screen.getByRole("textbox");
    expect(press({ key: "Z", code: "KeyZ", shiftKey: true }, field).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    expect(press({ key: "ß", code: "KeyS", altKey: true }, field).defaultPrevented).toBe(true);
    expect(hint()).toHaveTextContent("Assistant");
    expect(press({ key: "a", code: "KeyA" }, field).defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lists exactly the bound leaves in the help, which ? opens and Esc closes", () => {
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={() => {}} />
        <Bind on="l" label="Copy link" run={null} />
        <Bind on="y" label="Redo" run={() => {}} where="root" />
      </KeymapProvider>,
    );
    leader();
    press({ key: "?", code: "Slash", shiftKey: true });
    const rows = [...document.querySelectorAll('[data-slot="key-help-row"]')].map(r => r.textContent);
    expect(rows).toEqual(["AssistantAlt+S A", "KeybindsAlt+S ?", "RedoY"]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(document.querySelector('[data-slot="key-help"]')).toBeNull();
  });

  it("drops a binding with the component that contributed it, and runs its latest closure", () => {
    const first = vi.fn();
    const second = vi.fn();
    const tree = (run: () => void, mounted: boolean) => (
      <KeymapProvider leader={{ key: "s", alt: true }}>{mounted && <Bind on="a" label="Assistant" run={run} />}</KeymapProvider>
    );
    const view = render(tree(first, true));
    view.rerender(tree(second, true));
    leader();
    press({ key: "a", code: "KeyA" });
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    view.rerender(tree(second, false));
    leader();
    expect(press({ key: "a", code: "KeyA" }).defaultPrevented).toBe(false);
  });

  it("goes ahead of the page's own handlers, which get only what it leaves", () => {
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={() => {}} />
      </KeymapProvider>,
    );
    const seen: string[] = [];
    const own = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener("keydown", own, { capture: true });
    leader();
    press({ key: "a", code: "KeyA" });
    press({ key: "x", code: "KeyX" });
    document.removeEventListener("keydown", own, { capture: true });
    expect(seen).toEqual(["x"]);
  });

  it("hears a same-origin frame while it holds focus: its own keys first, the rest to the frame", () => {
    const run = vi.fn();
    const undo = vi.fn();
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={run} />
        <Bind on="Z" label="Undo" run={undo} where="root" />
        <iframe title="framed" />
      </KeymapProvider>,
    );
    const frame = screen.getByTitle<HTMLIFrameElement>("framed");
    const inner = frame.contentWindow! as Window & typeof globalThis;
    const seen: string[] = [];
    inner.document.addEventListener("keydown", e => seen.push(e.key));
    focusFrame(frame, window);
    const pressIn = pressInto(inner);
    expect(pressIn({ key: "s", code: "KeyS", altKey: true }).defaultPrevented).toBe(true);
    expect(hint()).toHaveTextContent("Assistant");
    pressIn({ key: "a", code: "KeyA" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(pressIn({ key: "x", code: "KeyX" }).defaultPrevented).toBe(false);
    expect(pressIn({ key: "Z", code: "KeyZ", shiftKey: true }).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    expect(seen).toEqual(["x", "Z"]);
    act(() => {
      window.dispatchEvent(new FocusEvent("focus"));
    });
    pressIn({ key: "s", code: "KeyS", altKey: true });
    expect(seen).toEqual(["x", "Z", "s"]);
  });

  it("keeps hearing a focused frame while bindings come and go", () => {
    const run = vi.fn();
    const tree = (mounted: boolean) => (
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={run} />
        {mounted && <Bind on="b" label="Other" run={() => {}} />}
        <iframe title="framed" />
      </KeymapProvider>
    );
    const view = render(tree(false));
    const frame = screen.getByTitle<HTMLIFrameElement>("framed");
    focusFrame(frame, window);
    view.rerender(tree(true));
    const pressIn = pressInto(frame.contentWindow! as Window & typeof globalThis);
    pressIn({ key: "s", code: "KeyS", altKey: true });
    pressIn({ key: "a", code: "KeyA" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("follows focus into a frame nested in a frame", () => {
    const run = vi.fn();
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={run} />
        <iframe title="outer" />
      </KeymapProvider>,
    );
    const outer = screen.getByTitle<HTMLIFrameElement>("outer");
    const outerWin = outer.contentWindow! as Window & typeof globalThis;
    const nested = outerWin.document.body.appendChild(outerWin.document.createElement("iframe"));
    focusFrame(outer, window);
    focusFrame(nested, outerWin);
    const pressIn = pressInto(nested.contentWindow! as Window & typeof globalThis);
    pressIn({ key: "s", code: "KeyS", altKey: true });
    pressIn({ key: "a", code: "KeyA" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("binds an element's keys under the scope its host assigns, while it is connected and until it aborts", () => {
    const leads = vi.fn();
    render(
      <KeymapProvider leader={{ key: "s", alt: true }} elements={{ "mfe-sites": { on: { key: "x" }, label: "Sites" } }}>
        <Bind on="a" label="Assistant" run={() => {}} />
      </KeymapProvider>,
    );
    const element = document.body.appendChild(document.createElement("mfe-sites"));
    const inner = element.appendChild(document.createElement("div"));
    const contributed = new AbortController();
    act(() => dispatchKeymap(inner, { on: { key: "l" }, run: { label: "Leads", run: leads } }, contributed.signal));
    leader();
    expect(hint()).toHaveTextContent("Sites");
    press({ key: "x", code: "KeyX" });
    expect(hint()).toHaveTextContent("Alt+S X");
    press({ key: "l", code: "KeyL" });
    expect(leads).toHaveBeenCalledTimes(1);

    element.remove();
    leader();
    expect(hint()).not.toHaveTextContent("Sites");
    press({ key: "Escape", code: "Escape" });
    document.body.appendChild(element);
    leader();
    press({ key: "x", code: "KeyX" });
    press({ key: "l", code: "KeyL" });
    expect(leads).toHaveBeenCalledTimes(2);

    act(() => contributed.abort());
    leader();
    expect(hint()).not.toHaveTextContent("Sites");
    element.remove();
  });

  it("refuses an element's keys when its host assigns it no scope", () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<KeymapProvider leader={{ key: "s", alt: true }}>{null}</KeymapProvider>);
    const element = document.body.appendChild(document.createElement("mfe-stray"));
    act(() => dispatchKeymap(element, { on: { key: "l" }, run: { label: "Leads", run: () => {} } }, new AbortController().signal));
    window.removeEventListener("error", onError);
    vi.restoreAllMocks();
    element.remove();
    expect(String(errors[0])).toMatch(/<mfe-stray>/);
  });

  it("refuses two bindings on one chord", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <KeymapProvider leader={{ key: "s", alt: true }}>
          <Bind on="a" label="One" run={() => {}} />
          <Bind on="a" label="Two" run={() => {}} />
        </KeymapProvider>,
      ),
    ).toThrow(/twice/);
    vi.restoreAllMocks();
  });
});
