import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { BottomTabBar } from "../src/components/shell/bottom-tab-bar";
import type { NavItem } from "../src/components/shell/nav-model";

const Glyph = () => null;

const FakeLink = ({ onClick, ...props }: React.ComponentProps<"a">) => (
  <a
    data-fake-link=""
    {...props}
    onClick={(e) => {
      onClick?.(e);
      e.preventDefault();
    }}
  />
);

const TABS: NavItem[] = [
  { id: "home", href: "/", label: "Home", icon: Glyph },
  { id: "invest", href: "/invest", label: "Invest", icon: Glyph },
  { id: "wallet", href: "/wallet", label: "Wallet", icon: Glyph },
  { id: "account", href: "/settings", label: "Account", also: ["/profile", "/notifications"], badge: 7, icon: Glyph },
];

const bar = (pathname: string, extra: Partial<React.ComponentProps<typeof BottomTabBar>> = {}) => (
  <BottomTabBar items={TABS} pathname={pathname} linkComponent={FakeLink} {...extra} />
);

const rules = (root: HTMLElement) => root.querySelectorAll('[data-slot="tab-bar-rule"]');

describe("BottomTabBar", () => {
  it("lights the tab that claims the path through `also`", () => {
    const { getByRole } = render(bar("/notifications/3"));
    expect(getByRole("link", { name: /Account/ })).toHaveAttribute("aria-current", "page");
    expect(getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("rules the current tab only, and no tab on an unclaimed route", () => {
    const { container, getByRole, rerender } = render(bar("/wallet"));
    expect(rules(container)).toHaveLength(1);
    expect(getByRole("link", { name: /Wallet/ })).toContainElement(rules(container)[0] as HTMLElement);
    rerender(bar("/admin"));
    expect(rules(container)).toHaveLength(0);
  });

  it("moves the mark on a plain click, before the pathname changes", () => {
    const onNavigate = vi.fn();
    const { container, getByRole } = render(bar("/", { onNavigate }));
    fireEvent.click(getByRole("link", { name: "Invest" }));
    expect(getByRole("link", { name: "Invest" })).toHaveAttribute("aria-current", "page");
    expect(getByRole("link", { name: "Invest" })).toContainElement(rules(container)[0] as HTMLElement);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    fireEvent.click(getByRole("link", { name: "Wallet" }), { metaKey: true });
    expect(getByRole("link", { name: "Invest" })).toHaveAttribute("aria-current", "page");
  });

  it("puts a numeric badge on the icon's corner and lets labels rename things", () => {
    const { getByRole } = render(
      bar("/", { labels: { nav: "Tabs", badge: (n) => `${n} unread` } }),
    );
    expect(getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
    const account = getByRole("link", { name: /Account/ });
    expect(account.querySelector('[data-slot="nav-badge"]')).toHaveAttribute("data-variant", "corner");
    expect(account).toHaveTextContent("7 unread");
  });

  it("uses linkComponent for every tab", () => {
    const { getAllByRole } = render(bar("/"));
    for (const link of getAllByRole("link")) expect(link).toHaveAttribute("data-fake-link");
  });
});
