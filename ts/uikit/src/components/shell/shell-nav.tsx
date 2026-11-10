"use client";

import * as React from "react";
import { cn } from "../../lib/cn";
import { useFloating } from "../../primitives/use-floating";
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
        unfold?: never;
        /** Above the groups — the brand lock-up. */
        header?: React.ReactNode;
        /** Below the footer groups — the signed-in account, a sign-out. */
        footer?: React.ReactNode;
      }
    | {
        /**
         * Set while the rail is folded to icons: how it unfolds, which a click on a panel's icon asks
         * for. Hovering or focusing an icon opens its flyout — the name, an item's description, a
         * `menu` panel's body — until the pointer and focus leave.
         */
        unfold: (() => void) | undefined;
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
  unfold,
  renderItem,
  onItemIntent,
  onNavigate,
  labels = {},
  collapsible = false,
  className,
  ...props
}: ShellNavProps) {
  const [pendingId, markPending] = usePendingNavigation(pathname);
  const folded = unfold !== undefined;
  const [peek, setPeek] = React.useState<string | null>(null);
  if (!folded && peek !== null) setPeek(null);
  const flyouts: Flyouts = { peek, setPeek };
  const all = [...groups, ...footerGroups].flatMap((s) => (isNavPanel(s) ? [] : s.items));
  const currentId =
    (pendingId !== null && all.some((i) => i.id === pendingId) ? pendingId : undefined) ??
    resolveActiveNavItem(all, pathname)?.id;
  const section = (s: NavSection) =>
    isNavPanel(s) ? (
      <ShellNavPanel key={s.id} panel={s} unfold={unfold} flyouts={flyouts} />
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
        flyouts={flyouts}
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

/** The one icon whose flyout is up. */
interface Flyouts {
  peek: string | null;
  setPeek: React.Dispatch<React.SetStateAction<string | null>>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// Up while the pointer or focus is on the icon or its flyout (a DOM child of the wrapper, so crossing
// onto it is no leave); a tap is the icon's own. The icon is the wrapper's first element.
function useFlyout(id: string, { peek, setPeek }: Flyouts) {
  const open = peek === id;
  const close = (p: string | null) => (p === id ? null : p);
  const wrapper = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") setPeek(id);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") setPeek(close);
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget)) return; // back from its flyout, as on Escape
      if (e.target === e.currentTarget.firstElementChild && e.target.matches(":focus-visible"))
        setPeek(id);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setPeek(close);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      const icon = e.currentTarget.firstElementChild as HTMLElement | null;
      if (e.key === "Escape" && open) {
        setPeek(null);
        icon?.focus();
      } else if ((e.key === "ArrowRight" || e.key === "ArrowDown") && e.target === icon && open) {
        const first = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => el !== icon);
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }
    },
  };
  return { open, wrapper };
}

// A card beside its icon, on the rail's surface: the caret points at the icon's centre, and a strip
// over the gap keeps the pointer inside on its way across. No motion, in or out.
const FLYOUT =
  "absolute z-30 flex max-h-[calc(100dvh-1rem)] flex-col rounded-panel border border-border bg-card shadow-lg before:absolute before:top-(--floating-anchor-offset) before:-left-[5px] before:size-2.5 before:-translate-y-1/2 before:rotate-45 before:border-b before:border-l before:border-border before:bg-card after:absolute after:inset-y-0 after:-left-2.5 after:w-2.5";
// As tall as the icon: `align: "start"` sets the title level with it.
const FLYOUT_TITLE = "flex h-(--control-h-md) shrink-0 items-center px-3 text-sm font-semibold text-ink";

// Expanded the body is `contents`, so its own classes size it in the rail (a tree that fills and
// scrolls itself); folded it is hidden, or a `menu` panel's flyout. One node in every state: a fold
// never remounts it. Its icon's click unfolds the rail, where the body is whole.
function ShellNavPanel({ panel, unfold, flyouts }: { panel: NavPanel; unfold: (() => void) | undefined; flyouts: Flyouts }) {
  const trigger = React.useRef<HTMLButtonElement>(null);
  const folded = unfold !== undefined;
  const { open, wrapper } = useFlyout(panel.id, flyouts);
  const menu = panel.menu === true;
  const placed = useFloating({ anchorRef: trigger, open: folded && menu && open, side: "right", align: "start", offset: 8 });
  const sectionId = React.useId();
  const Icon = panel.icon;
  return (
    <div
      data-slot="shell-nav-panel"
      hidden={panel.hidden}
      className={folded ? "flex flex-col items-center" : "contents"}
      {...(folded && wrapper)}
    >
      {folded && (
        <IconButton
          ref={trigger}
          aria-label={panel.label}
          {...(menu && { "aria-expanded": open, "aria-controls": sectionId })}
          className="[--control-box:var(--control-h-md)]" // an item's icon box, so the flyout's title sits level with either
          onClick={unfold}
        >
          <Icon className="size-4.5" />
        </IconButton>
      )}
      {folded && !menu && <RailFlyout anchor={trigger} open={open} title={panel.label} />}
      <section
        ref={placed.floatingRef}
        id={sectionId}
        aria-label={panel.label}
        hidden={folded && !(menu && open)}
        style={folded && menu ? placed.style : undefined}
        onClick={folded && menu ? () => flyouts.setPeek(null) : undefined}
        className={folded && menu ? cn(FLYOUT, "w-(--shell-rail-w)") : "contents"}
      >
        {folded && menu && (
          <p aria-hidden="true" className={cn(FLYOUT_TITLE, "border-b border-border")}>
            {panel.label}
          </p>
        )}
        <div className={folded && menu ? "min-h-0 overflow-y-auto p-1.5" : "contents"}>{panel.content}</div>
      </section>
    </div>
  );
}

/** The name, and what is there, beside a folded icon; read through the icon, so hidden from the tree. */
function RailFlyout({
  anchor,
  open,
  title,
  description,
  descriptionId,
}: {
  anchor: React.RefObject<Element | null>;
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  descriptionId?: string;
}) {
  const { floatingRef, style } = useFloating({ anchorRef: anchor, open, side: "right", align: "start", offset: 8 });
  return (
    <div
      ref={floatingRef as React.RefObject<HTMLDivElement>}
      data-slot="shell-nav-flyout"
      aria-hidden="true"
      hidden={!open}
      style={style}
      className={cn(FLYOUT, "w-max max-w-(--shell-rail-w)")}
    >
      <p className={FLYOUT_TITLE}>{title}</p>
      {description !== undefined && (
        <p id={descriptionId} className="-mt-1.5 px-3 pb-2.5 text-xs text-ink-soft">
          {description}
        </p>
      )}
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
  flyouts,
}: {
  group: NavGroup;
  currentId: string | undefined;
  pendingId: string | null;
  pathname: string;
  row: RowContext;
  labels: ShellNavLabels;
  collapsible: boolean;
  folded: boolean;
  flyouts: Flyouts;
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
          return <ShellNavIcon key={item.id} item={item} state={state} row={row} flyouts={flyouts} />;
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
// icon's corner, as on a tab. The flyout repeats the name for the eye and describes the link.
function ShellNavIcon({
  item,
  state,
  row,
  flyouts,
}: {
  item: NavItem;
  state: NavItemState;
  row: RowContext;
  flyouts: Flyouts;
}) {
  const li = React.useRef<HTMLLIElement>(null);
  const { open, wrapper } = useFlyout(item.id, flyouts);
  const descriptionId = React.useId();
  const Icon = item.icon;
  return (
    <li ref={li} className="flex flex-col" {...wrapper}>
      <NavLink
        describedBy={descriptionId}
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
      <RailFlyout anchor={li} open={open} title={item.label} description={item.description} descriptionId={descriptionId} />
    </li>
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
