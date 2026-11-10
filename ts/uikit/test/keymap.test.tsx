import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { KeymapProvider, type Leaf, useBinding } from "../src/components/shell/keymap";

function Bind({ on, label, run, where }: { on: string; label: string; run: Leaf["run"]; where?: "leader" | "root" }) {
  useBinding({ on: { key: on }, run: { label, run } }, where);
  return null;
}

function Go({ home }: { home: () => void }) {
  useBinding({ on: { key: "g" }, label: "go", children: [{ on: { key: "h" }, run: { label: "Home", run: home } }] });
  return null;
}

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
};
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

  it("never acts on a key aimed at a field, and drops the open scope", () => {
    const run = vi.fn();
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={run} />
        <textarea />
      </KeymapProvider>,
    );
    const field = screen.getByRole("textbox");
    expect(press({ key: "ß", code: "KeyS", altKey: true }, field).defaultPrevented).toBe(false);
    expect(hint()).toBeNull();
    leader();
    press({ key: "a", code: "KeyA" }, field);
    expect(hint()).toBeNull();
    expect(run).not.toHaveBeenCalled();
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
    render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bind on="a" label="Assistant" run={run} />
        <iframe title="framed" />
      </KeymapProvider>,
    );
    const frame = screen.getByTitle<HTMLIFrameElement>("framed");
    const inner = frame.contentWindow! as Window & typeof globalThis;
    const field = inner.document.body.appendChild(inner.document.createElement("textarea"));
    const seen: string[] = [];
    inner.document.addEventListener("keydown", e => seen.push(e.key));
    act(() => {
      frame.focus();
      window.dispatchEvent(new FocusEvent("blur"));
    });
    const pressIn = (init: KeyboardEventInit, target: EventTarget = inner.document.body) => {
      const e = new inner.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => {
        target.dispatchEvent(e);
      });
      return e;
    };
    expect(pressIn({ key: "s", code: "KeyS", altKey: true }).defaultPrevented).toBe(true);
    expect(hint()).toHaveTextContent("Assistant");
    pressIn({ key: "a", code: "KeyA" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(pressIn({ key: "x", code: "KeyX" }).defaultPrevented).toBe(false);
    expect(pressIn({ key: "ß", code: "KeyS", altKey: true }, field).defaultPrevented).toBe(false);
    expect(seen).toEqual(["x", "ß"]);
    act(() => {
      window.dispatchEvent(new FocusEvent("focus"));
    });
    pressIn({ key: "s", code: "KeyS", altKey: true });
    expect(seen).toEqual(["x", "ß", "s"]);
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
