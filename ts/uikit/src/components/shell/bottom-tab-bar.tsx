"use client";

import * as React from "react";
import { cn } from "../../lib/cn";
import { NavBadge } from "./nav-badge";
import { labelTitle, NavLink, type NavLinkCallbacks } from "./nav-link";
import { resolveActiveNavItem, type NavItem } from "./nav-model";
import { usePendingNavigation } from "./use-shell-nav";

export interface BottomTabBarLabels {
  /** Accessible name of the bar. Default `"Main"`. */
  nav?: string;
  /** Spoken text of a numeric badge, given the real count. Default `"{n} new"`. */
  badge?: (count: number) => string;
}

export interface BottomTabBarProps
  extends Omit<React.ComponentProps<"nav">, "children">,
    NavLinkCallbacks {
  /**
   * The tabs, in order. Five is the most a phone holds — every label gets a
   * fifth of ~390px. A tab standing in for several rail rows lists their paths
   * in `also`. `trailing` is not drawn here; `badge` sits on the icon's corner.
   */
  items: readonly NavItem[];
  pathname: string;
  linkComponent?: React.ElementType;
  labels?: BottomTabBarLabels;
}

/**
 * The mobile tab bar: equal tabs, a rule over the current one, and a corner
 * badge. Position-agnostic — `AppShell` pins it to the bottom of the viewport and
 * hides it from its breakpoint up; the bar itself reserves the bottom safe area
 * under its `--shell-tab-bar-h`. Each tab is `min-w-0`: a long label truncates
 * instead of widening its tab.
 */
export function BottomTabBar({
  items,
  pathname,
  linkComponent,
  onItemIntent,
  onNavigate,
  labels = {},
  className,
  ...props
}: BottomTabBarProps) {
  const [pendingId, markPending] = usePendingNavigation(pathname);
  const currentId =
    (pendingId !== null && items.some((i) => i.id === pendingId) ? pendingId : undefined) ??
    resolveActiveNavItem(items, pathname)?.id;
  return (
    <nav
      data-slot="tab-bar"
      aria-label={labels.nav ?? "Main"}
      className={cn(
        "relative box-content flex h-(--shell-tab-bar-h) items-center border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom,0px)]",
        className,
      )}
      {...props}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.id === currentId;
        return (
          <NavLink
            key={item.id}
            item={item}
            current={active}
            pending={item.id === pendingId}
            linkComponent={linkComponent}
            markPending={markPending}
            onItemIntent={onItemIntent}
            onNavigate={onNavigate}
            className={cn(
              "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 self-stretch rounded-row py-1 font-medium",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary",
              active ? "text-primary-ink" : "text-ink-soft hover:text-ink",
              item.disabled && "cursor-not-allowed opacity-(--disabled-opacity)",
            )}
          >
            {active && <span data-slot="tab-bar-rule" aria-hidden className="absolute top-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full bg-primary-ink" />}
            <span className="relative shrink-0">
              <Icon className="size-5" />
              {typeof item.badge === "number" ? (
                <NavBadge
                  count={item.badge}
                  variant="corner"
                  {...(labels.badge ? { label: labels.badge } : {})}
                />
              ) : (
                item.badge
              )}
            </span>
            <span className="w-full truncate text-center text-xs" title={labelTitle(item.label)}>
              {item.label}
            </span>
          </NavLink>
        );
      })}
    </nav>
  );
}
