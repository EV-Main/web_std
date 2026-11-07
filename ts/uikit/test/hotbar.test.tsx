import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Hotbar, type HotbarAction, type HotbarProps } from "../src/components/shell/hotbar";
import { KeymapProvider, useBinding } from "../src/components/shell/keymap";

const Glyph = ({ className }: { className?: string }) => <svg className={className} />;

function setup(actions: Partial<HotbarAction>[], extra: Partial<HotbarProps> = {}) {
  const full = actions.map(a => ({ id: a.label!, icon: Glyph, onSelect: vi.fn(), ...a }) as HotbarAction);
  const view = render(
    <KeymapProvider leader={{ key: "s", alt: true }}>
      <Hotbar actions={full} {...extra} />
    </KeymapProvider>,
  );
  const bar = () => within(view.container.querySelector<HTMLElement>('[data-slot="hotbar"]')!);
  const shown = () => bar().queryAllByRole("button").filter(b => b.dataset["slot"] === "hotbar-action").map(b => b.textContent);
  const customize = () => fireEvent.click(bar().getByRole("button", { name: "Customize" }));
  return { ...view, actions: full, bar, shown, customize };
}

afterEach(() => localStorage.clear());

describe("Hotbar", () => {
  it("shows the keys of the binding an action names, while it is bound", () => {
    function Bound({ run }: { run: (() => void) | null }) {
      useBinding({ on: { key: "n" }, run: { id: "next", label: "Next lead", run } });
      return null;
    }
    const full = [{ id: "next", label: "Next lead", icon: Glyph, onSelect: vi.fn(), binding: "next" }];
    const view = render(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bound run={() => {}} />
        <Hotbar actions={full} />
      </KeymapProvider>,
    );
    expect(screen.getByRole("button", { name: /Next lead/ })).toHaveTextContent("Alt+S N");
    view.rerender(
      <KeymapProvider leader={{ key: "s", alt: true }}>
        <Bound run={null} />
        <Hotbar actions={full} />
      </KeymapProvider>,
    );
    expect(screen.getByRole("button", { name: /Next lead/ })).toHaveTextContent(/^Next lead$/);
  });

  it("keeps the user's pins across a remount, and Reset brings the defaults back", () => {
    const spec = [{ label: "Next lead" }, { label: "Add note", pinned: false }];
    const first = setup(spec);
    first.customize();
    fireEvent.click(screen.getByRole("checkbox", { name: /Next lead/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Add note/ }));
    expect(first.shown()).toEqual(["Add note"]);
    cleanup();

    const second = setup(spec);
    expect(second.shown()).toEqual(["Add note"]);
    second.customize();
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(second.shown()).toEqual(["Next lead"]);
    expect(localStorage.length).toBe(0);
  });

  it("marks a pressed toggle, and the app flips it", () => {
    const { bar } = setup([{ label: "Places", pressed: true }, { label: "Agent", pressed: false }]);
    expect(bar().getByRole("button", { name: "Places" })).toHaveAttribute("aria-pressed", "true");
    expect(bar().getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "false");
  });

  it("gives the strip to a takeover, keeping the status", () => {
    const { bar, shown } = setup([{ label: "Next lead" }], {
      takeover: { tone: "error", message: "Call-back overdue" },
      status: <span>Synced</span>,
    });
    expect(bar().getByRole("alert")).toHaveTextContent("Call-back overdue");
    expect(shown()).toEqual([]);
    expect(bar().queryByRole("button", { name: "Customize" })).toBeNull();
    expect(bar().getByText("Synced")).toBeInTheDocument();
  });
});
