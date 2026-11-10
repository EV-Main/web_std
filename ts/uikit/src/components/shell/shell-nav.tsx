"use client";

import * as React from "react";
import { cn } from "../../lib/cn";
import { useDismissableLayer } from "../../primitives/dismissable-layer";
import { Tooltip, TooltipContent, TooltipTrigger } from "../atomic/tooltip";
import { IconButton } from "../derived/icon-button";
import { NavBadge } from "./nav-badge";
import { CURRENT, labelTitle, NAV_FOCUS, NavLink, ROW, type NavLinkCallbacks } from "./nav-link";
import { NavCollapse, NavGroupHeader, useNavGroupOpen, type NavCollapseLabels } from "./nav-collapse";
import {
  isNavPanel,
  navItemMatch,
  resolveActiveNavItem,
  type NavGroup,
  type NavItem,
  type NavItemState,
  type NavPanel,
  type NavSection,
} from "./nav-model";
import { usePendingNavigation } from "./use-shell-nav";

export interface ShellNavLabels extends NavCollapseLabels {
  /** Accessible name of the nav holding `groups`. Default `"Main"`. */
  primary?: string;
  /** Accessible name of the nav holding `footerGroups`. Default `"Account"`. */
  footer?: string;
  /** Spoken text of a numeric badge, given the real count. Default `"{n} new"`. */
  badge?: (count: number) => string;
}

interface ShellNavBaseProps
  extends Omit<React.ComponentProps<"aside">, "children">,
    NavLinkCallbacks {
  groups: readonly NavSection[];
  /** Pinned to the bottom of the rail (profile, notifications, settings). */
  footerGroups?: readonly NavSection[];
  /** The router's current path — `usePathname()` in Next. */
  pathname: string;
  /** Your router's link (`next/link`); defaults to a plain `<a>`. */
  linkComponent?: React.ElementType;
  /** Replaces an expanded row's content (icon, label, badge); the link, `aria-current` and the marker stay the kit's. */
  renderItem?: (item: NavItem, state: NavItemState) => React.ReactNode;
  labels?: ShellNavLabels;
  /** Makes every labelled group collapsible; a group's own `collapsible` wins. Default `false`. */
  collapsible?: boolean;
}

/**
 * A rail that folds holds nothing without an icon, so its brand and account go to the top bar;
 * one that never folds may carry them here.
 */
export type ShellNavProps = ShellNavBaseProps &
  (
    | {
        folded?: never;
        /** Above the groups — the brand lock-up. */
        header?: React.ReactNode;
        /** Below the footer groups — the signed-in account, a sign-out. */
        footer?: React.ReactNode;
      }
    | {
        /** Icons only; a panel's body opens over the rail from its icon, drawn as the expanded rail would. */
        folded: boolean;
        header?: never;
        footer?: never;
      }
  );

// Folded, a line between drawn sections stands in for their labels; a `hidden` panel draws none.
const FOLDED_NAV =
  "flex flex-col gap-2 [&>:not([hidden])~:not([hidden])]:border-t [&>:not([hidden])~:not([hidden])]:border-border [&>:not([hidden])~:not([hidden])]:pt-2";

/**
 * The app's left rail: data-driven groups, a footer block pinned to the bottom,
 * one sliding marker per group, and an optimistic mark on click so the row
 * answers the click rather than the router's round-trip.
 *
 * Exactly one row across the rail is current — the strongest claim on the path
 * (see {@link resolveActiveNavItem}) — so overlapping `prefix` items are safe.
 * Visibility (roles, flags) is the caller's: pass only the items to show.
 */
export function ShellNav({
  groups,
  footerGroups = [],
  pathname,
  linkComponent,
  header,
  footer,
  folded = false,
  renderItem,
  onItemIntent,
  onNavigate,
  labels = {},
  collapsible = false,
  className,
  ...props
}: ShellNavProps) {
  const [pendingId, markPending] = usePendingNavigation(pathname);
  const [peek, setPeek] = React.useState<string | null>(null);
  if (!folded && peek !== null) setPeek(null);
  const all = [...groups, ...footerGroups].flatMap((s) => (isNavPanel(s) ? [] : s.items));
  const currentId =
    (pendingId !== null && all.some((i) => i.id === pendingId) ? pendingId : undefined) ??
    resolveActiveNavItem(all, pathname)?.id;
  const section = (s: NavSection) =>
    isNavPanel(s) ? (
      <ShellNavPanel
        key={s.id}
        panel={s}
        folded={folded}
        open={peek === s.id}
        onOpenChange={(open) => setPeek(open ? s.id : null)}
      />
    ) : (
      <ShellNavSection
        key={s.id}
        group={s}
        currentId={currentId}
        pendingId={pendingId}
        pathname={pathname}
        labels={labels}
        collapsible={collapsible}
        folded={folded}
        row={{ linkComponent, markPending, onItemIntent, onNavigate, renderItem, badgeLabel: labels.badge }}
      />
    );
  // A panel may fill the rest of the rail and scroll itself, so the nav holding one takes that room.
  const fills = groups.some(isNavPanel);
  const navClass = folded ? FOLDED_NAV : "flex flex-col gap-4.5";
  return (
    <aside
      data-slot="shell-nav"
      data-state={folded ? "folded" : "expanded"}
      className={cn(
        "relative flex h-full w-(--shell-rail-w) flex-col gap-7 overflow-y-auto border-r border-border bg-card px-4.5 pb-5 pt-6 [--nav-menu-description:none]",
        className,
        // After `className`: a caller's width or padding is the expanded rail's.
        folded && "w-(--shell-rail-folded-w) gap-2 overflow-visible px-2 pt-3",
      )}
      {...props}
    >
      {header}
      <nav
        aria-label={labels.primary ?? "Main"}
        className={cn(navClass, fills && "min-h-0 flex-1")}
      >
        {groups.map(section)}
      </nav>
      {!fills && <div className="flex-1" />}
      {footerGroups.length > 0 && (
        <nav aria-label={labels.footer ?? "Account"} className={navClass}>
          {footerGroups.map(section)}
        </nav>
      )}
      {footer}
    </aside>
  );
}

// Expanded the body is `contents`, so its own classes size it in the rail (a tree that fills and
// scrolls itself); folded the same node is the flyout. One node in both: a fold never remounts it.
function ShellNavPanel({
  panel,
  folded,
  open,
  onOpenChange,
}: {
  panel: NavPanel;
  folded: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trigger = React.useRef<HTMLButtonElement>(null);
  const layer = useDismissableLayer({
    enabled: folded && open,
    onDismiss: () => onOpenChange(false),
    exclude: [trigger],
  });
  const Icon = panel.icon;
  return (
    <div
      data-slot="shell-nav-panel"
      hidden={panel.hidden}
      className={folded ? "flex flex-col items-center" : "contents"}
    >
      {folded && (
        <Tooltip>
          <TooltipTrigger asChild>
            <IconButton ref={trigger} aria-label={panel.label} pressed={open} onClick={() => onOpenChange(!open)}>
              <Icon className="size-4.5" />
            </IconButton>
          </TooltipTrigger>
          {!open && <TooltipContent side="right">{panel.label}</TooltipContent>}
        </Tooltip>
      )}
      <section
        ref={layer}
        aria-label={panel.label}
        hidden={folded && !open}
        className={
          folded
            ? "absolute inset-y-0 left-0 z-30 flex w-(--shell-rail-w) flex-col border-r border-border bg-card p-2 shadow-lg"
            : "contents"
        }
      >
        {panel.content}
      </section>
    </div>
  );
}

interface RowContext extends NavLinkCallbacks {
  linkComponent: React.ElementType | undefined;
  markPending: (id: string) => void;
  renderItem: ShellNavProps["renderItem"];
  badgeLabel: ((count: number) => string) | undefined;
}

function ShellNavSection({
  group,
  currentId,
  pendingId,
  pathname,
  row,
  labels,
  collapsible,
  folded,
}: {
  group: NavGroup;
  currentId: string | undefined;
  pendingId: string | null;
  pathname: string;
  row: RowContext;
  labels: ShellNavLabels;
  collapsible: boolean;
  folded: boolean;
}) {
  const labelId = React.useId();
  const regionId = React.useId();
  const [open, setOpen] = useNavGroupOpen(group, group.items.some((i) => i.id === currentId));
  const folds = !folded && (group.collapsible ?? collapsible) && group.label !== undefined;
  const landing =
    group.href !== undefined && navItemMatch({ href: group.href, match: "exact" }, pathname) !== null;
  const content = (
    <div className={cn(folds && "pt-1")}>
      <ul
        aria-labelledby={group.label !== undefined ? labelId : undefined}
        className={cn("flex flex-col gap-1", folds && "pl-3", folded && "items-center")}
      >
        {group.items.map((item) => {
          const state = { active: item.id === currentId, pending: item.id === pendingId };
          if (!folded)
            return (
              <li key={item.id} className="flex flex-col">
                <ShellNavRow item={item} nested={folds} state={state} row={row} />
              </li>
            );
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <li className="flex flex-col">
                  <ShellNavIcon item={item} state={state} row={row} />
                </li>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </ul>
    </div>
  );
  if (!folds) {
    return (
      <div
        data-slot="shell-nav-section"
        className={cn(
          "flex flex-col gap-1",
          group.label !== undefined && !folded && "pl-1",
        )}
      >
        {group.label !== undefined && (
          <p
            id={labelId}
            className={folded ? "sr-only" : "mb-0.5 text-xs font-semibold uppercase tracking-widest text-ink-soft"}
          >
            {group.label}
          </p>
        )}
        {content}
      </div>
    );
  }
  return (
    <div data-slot="shell-nav-section" data-state={open ? "open" : "closed"} className="flex flex-col">
      <NavGroupHeader
        label={group.label}
        labelId={labelId}
        regionId={regionId}
        open={open}
        onToggle={() => setOpen(!open)}
        href={group.href}
        linkComponent={row.linkComponent}
        current={landing}
        labels={labels}
      />
      <NavCollapse open={open} id={regionId}>
        {content}
      </NavCollapse>
    </div>
  );
}

// The label stays in the link, read but not drawn, so the row keeps its name; a count sits on the
// icon's corner, as on a tab.
function ShellNavIcon({ item, state, row }: { item: NavItem; state: NavItemState; row: RowContext }) {
  const Icon = item.icon;
  return (
    <NavLink
      item={item}
      current={state.active}
      pending={state.pending}
      linkComponent={row.linkComponent}
      markPending={row.markPending}
      onItemIntent={row.onItemIntent}
      onNavigate={row.onNavigate}
      className={cn(
        "grid size-(--control-h-md) place-items-center rounded-row",
        NAV_FOCUS,
        state.active ? CURRENT : "text-ink hover:bg-hover hover:text-primary-ink",
        item.disabled && "cursor-not-allowed opacity-(--disabled-opacity) hover:bg-transparent",
      )}
    >
      <span className="relative">
        <Icon className="size-4.5" />
        {typeof item.badge === "number" && (
          <NavBadge count={item.badge} variant="corner" {...(row.badgeLabel ? { label: row.badgeLabel } : {})} />
        )}
      </span>
      <span className="sr-only">{item.label}</span>
    </NavLink>
  );
}

function ShellNavRow({
  item,
  state,
  row,
  nested,
}: {
  item: NavItem;
  state: NavItemState;
  row: RowContext;
  nested: boolean;
}) {
  const Icon = item.icon;
  const trailing = typeof item.trailing === "function" ? item.trailing(state) : item.trailing;
  return (
    <NavLink
      item={item}
      current={state.active}
      pending={state.pending}
      linkComponent={row.linkComponent}
      markPending={row.markPending}
      onItemIntent={row.onItemIntent}
      onNavigate={row.onNavigate}
      title={labelTitle(item.label)}
      className={cn(
        ROW,
        NAV_FOCUS,
        state.active ? cn("font-medium", CURRENT) : cn("font-medium hover:bg-hover hover:text-primary-ink", nested ? "text-ink-mid" : "text-ink"),
        item.disabled && "cursor-not-allowed opacity-(--disabled-opacity) hover:bg-transparent",
      )}
    >
      {row.renderItem ? (
        row.renderItem(item, state)
      ) : (
        <>
          <Icon className="size-4.5 shrink-0" />
          {/* `min-w-0`: without it the label refuses to shrink below its own text and
              the rail widens to the longest translation instead of truncating. */}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {typeof item.badge === "number" ? (
            <NavBadge count={item.badge} {...(row.badgeLabel ? { label: row.badgeLabel } : {})} />
          ) : (
            item.badge
          )}
          {trailing}
        </>
      )}
    </NavLink>
  );
}
