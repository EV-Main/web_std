import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";
import { ShellNav } from "../src/components/shell/shell-nav";
import type { NavSection } from "../src/components/shell/nav-model";

// Mimics next/link: the caller's onClick runs first, then the link takes the
// click over (which jsdom could not navigate anyway).
const FakeLink = React.forwardRef<HTMLAnchorElement, React.ComponentProps<"a">>(
  function FakeLink({ onClick, ...props }, ref) {
    return (
      <a
        ref={ref}
        data-fake-link=""
        {...props}
        onClick={(e) => {
          onClick?.(e);
          e.preventDefault();
        }}
      />
    );
  },
);

const Icon = ({ className }: { className?: string }) => <svg data-testid="icon" className={className} />;

const GROUPS: NavSection[] = [
  {
    id: "main",
    label: "Your account",
    items: [
      { id: "home", href: "/", label: "Home", icon: Icon },
      { id: "invest", href: "/invest", label: "Invest", match: "exact", icon: Icon },
      { id: "wallet", href: "/wallet", label: "Wallet", icon: Icon },
    ],
  },
  {
    id: "products",
    label: "Products",
    items: [{ id: "arb", href: "/invest/arb", label: "Arb", icon: Icon }],
  },
];

const FOOTER: NavSection[] = [
  {
    id: "me",
    items: [
      { id: "profile", href: "/profile", label: "Profile", icon: Icon },
      { id: "inbox", href: "/notifications", label: "Notifications", badge: 150, icon: Icon },
      { id: "help", href: "mailto:help@example.com", label: "Support", external: true, icon: Icon },
    ],
  },
];

function nav(pathname: string, extra: Partial<React.ComponentProps<typeof ShellNav>> = {}) {
  return (
    <ShellNav
      groups={GROUPS}
      footerGroups={FOOTER}
      pathname={pathname}
      linkComponent={FakeLink}
      {...extra}
    />
  );
}

const current = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('[aria-current="page"]')).map((el) => el.textContent);

describe("ShellNav", () => {
  it("marks exactly one row current, and only that row", () => {
    const { container } = render(nav("/invest/arb/trade"));
    expect(current(container)).toEqual(["Arb"]);
  });

  it("names both navs and the groups, with overridable labels", () => {
    const { getByRole, rerender } = render(nav("/"));
    expect(getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(getByRole("navigation", { name: "Account" })).toBeInTheDocument();
    expect(getByRole("list", { name: "Your account" })).toBeInTheDocument();
    rerender(nav("/", { labels: { primary: "Primär", footer: "Konto", badge: (n) => `${n} ungelesen` } }));
    expect(getByRole("navigation", { name: "Primär" })).toBeInTheDocument();
    expect(getByRole("navigation", { name: "Konto" })).toBeInTheDocument();
    expect(getByRole("link", { name: /Notifications 150 ungelesen/ })).toBeInTheDocument();
  });

  it("caps the badge at 99+ but speaks the real count", () => {
    const { getByRole } = render(nav("/"));
    const link = getByRole("link", { name: /Notifications/ });
    expect(within(link).getByText("99+")).toHaveAttribute("aria-hidden", "true");
    expect(link).toHaveAccessibleName("Notifications 150 new");
  });

  it("routes in-app items through linkComponent and external ones through a plain <a>", () => {
    const { getByRole } = render(nav("/"));
    expect(getByRole("link", { name: "Wallet" })).toHaveAttribute("data-fake-link");
    expect(getByRole("link", { name: "Support" })).not.toHaveAttribute("data-fake-link");
  });

  it("moves the mark on click, before the pathname changes", () => {
    const onNavigate = vi.fn();
    const { container, getByRole, rerender } = render(nav("/", { onNavigate }));
    fireEvent.click(getByRole("link", { name: "Wallet" }));
    expect(current(container)).toEqual(["Wallet"]);
    expect(getByRole("link", { name: "Wallet" })).toHaveAttribute("data-pending", "true");
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "wallet" }));
    // the router lands: the URL is the truth again and the pending entry is gone
    rerender(nav("/wallet", { onNavigate }));
    expect(current(container)).toEqual(["Wallet"]);
    expect(getByRole("link", { name: "Wallet" })).not.toHaveAttribute("data-pending");
  });

  it("drops a pending mark the moment the pathname moves elsewhere", () => {
    const { container, getByRole, rerender } = render(nav("/"));
    fireEvent.click(getByRole("link", { name: "Wallet" }));
    rerender(nav("/invest"));
    expect(current(container)).toEqual(["Invest"]);
    rerender(nav("/"));
    expect(current(container)).toEqual(["Home"]);
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ])("leaves the mark alone on a %s click", (_name, init) => {
    const onNavigate = vi.fn();
    const { container, getByRole } = render(nav("/", { onNavigate }));
    fireEvent.click(getByRole("link", { name: "Wallet" }), init);
    expect(current(container)).toEqual(["Home"]);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("reports intent on hover and focus", () => {
    const onItemIntent = vi.fn();
    const { getByRole } = render(nav("/", { onItemIntent }));
    fireEvent.pointerEnter(getByRole("link", { name: "Wallet" }));
    fireEvent.focus(getByRole("link", { name: "Profile" }));
    expect(onItemIntent.mock.calls.map(([i]) => i.id)).toEqual(["wallet", "profile"]);
  });

  it("renders the header and footer slots, and lets renderItem replace a row's content", () => {
    const { getByText, getByRole } = render(
      nav("/wallet", {
        header: <span>ACME</span>,
        footer: <button type="button">Sign out</button>,
        renderItem: (item, state) => `${String(item.label)}${state.active ? " *" : ""}`,
      }),
    );
    expect(getByText("ACME")).toBeInTheDocument();
    expect(getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(getByRole("link", { name: "Wallet *" })).toHaveAttribute("aria-current", "page");
  });

  it("hands `trailing` the row's state", () => {
    const groups: NavSection[] = [
      {
        id: "g",
        items: [
          {
            id: "kyc",
            href: "/kyc",
            label: "Profile",
            icon: Icon,
            trailing: ({ active }) => <span>{active ? "on" : "off"}</span>,
          },
        ],
      },
    ];
    const { getByText } = render(<ShellNav groups={groups} pathname="/kyc" />);
    expect(getByText("on")).toBeInTheDocument();
  });
});

describe("ShellNav folded", () => {
  const tree = { id: "tree", label: "Places", icon: Icon, content: <input aria-label="Filter" /> };
  const SECTIONS: NavSection[] = [...GROUPS, tree];
  const rail = (folded: boolean, sections: NavSection[] = SECTIONS) => (
    <ShellNav groups={sections} pathname="/wallet" linkComponent={FakeLink} folded={folded} />
  );

  it("keeps every row's name and the current row when it folds", () => {
    const { container, getByRole } = render(rail(true));
    expect(getByRole("link", { name: "Wallet" })).toHaveAttribute("aria-current", "page");
    expect(getByRole("link", { name: "Arb" })).toBeInTheDocument();
    expect(current(container)).toEqual(["Wallet"]);
    expect(getByRole("list", { name: "Your account" })).toBeInTheDocument();
  });

  it("draws a panel inline when expanded, behind its icon when folded", () => {
    const { getByRole, queryByRole, rerender } = render(rail(false));
    expect(queryByRole("button", { name: "Places" })).toBeNull();
    expect(getByRole("textbox", { name: "Filter" })).toBeVisible();
    rerender(rail(true));
    const open = getByRole("button", { name: "Places" });
    expect(open).toHaveAttribute("aria-pressed", "false");
    expect(getByRole("textbox", { name: "Filter", hidden: true })).not.toBeVisible();
    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-pressed", "true");
    expect(getByRole("textbox", { name: "Filter" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(getByRole("textbox", { name: "Filter", hidden: true })).not.toBeVisible();
    fireEvent.click(open);
    fireEvent.click(open);
    expect(getByRole("textbox", { name: "Filter", hidden: true })).not.toBeVisible();
  });

  it("keeps a panel's body mounted across a fold, and a hidden panel mounted without an icon", () => {
    const { getByRole, queryByRole, rerender } = render(rail(false));
    const body = getByRole("textbox", { name: "Filter" });
    rerender(rail(true));
    expect(getByRole("textbox", { name: "Filter", hidden: true })).toBe(body);
    rerender(rail(false));
    expect(getByRole("textbox", { name: "Filter" })).toBe(body);
    rerender(rail(true, [...GROUPS, { ...tree, hidden: true }]));
    expect(queryByRole("button", { name: "Places" })).toBeNull();
    expect(getByRole("textbox", { name: "Filter", hidden: true })).toBe(body);
  });
});
