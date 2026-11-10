"use client";

import * as React from "react";
import { cn } from "../../lib/cn";
import { NAVIGATION_MENU_TRIGGER_CHEVRON } from "../../generated/navigation-menu";
import { iconShapes } from "../../icons/icon-shapes";
import { NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, navigationMenuTriggerStyle } from "../atomic/navigation-menu";
import { NavBadge } from "./nav-badge";
import { CURRENT, NAV_FOCUS, NavLink, type NavLinkCallbacks } from "./nav-link";
import { resolveActiveNavItem, type NavGroup, type NavItem } from "./nav-model";

/** Long enough to cross the gap between the trigger and its menu. */
const CLOSE_DELAY_MS = 150;

export interface NavMenuProps {
  label: React.ReactNode;
  /** Where a click on the trigger goes; the menu only previews. */
  href: string;
  /** The trigger is the page's own place. */
  current: boolean;
  /** Your router's link (`next/link`); defaults to a plain `<a>`. */
  linkComponent?: React.ElementType;
  /** The menu's body, a {@link NavMenuList} or an app's own; without one the trigger is a plain link. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A top bar's item that opens its menu while the pointer or focus is on it, the chevron flipping;
 * a click in the menu has navigated, so it closes. Goes inside a `NavigationMenuList`.
 */
export function NavMenu({ label, href, current, linkComponent, children, className }: NavMenuProps) {
  const [open, setOpen] = React.useState(false);
  const closing = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(closing.current), []);
  const menu = children !== undefined;
  const show = (next: boolean) => {
    window.clearTimeout(closing.current);
    if (next) setOpen(true);
    else closing.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const Link: React.ElementType = linkComponent ?? "a";
  return (
    <NavigationMenuItem
      open={open}
      onOpenChange={setOpen}
      {...(menu && {
        onPointerEnter: (e: React.PointerEvent) => e.pointerType !== "touch" && show(true), // a tap is the link's
        onPointerLeave: (e: React.PointerEvent) => e.pointerType !== "touch" && show(false),
        onFocus: () => show(true),
        onBlur: (e: React.FocusEvent) => !e.currentTarget.contains(e.relatedTarget) && show(false),
      })}
    >
      <NavigationMenuLink
        asChild
        className={cn(navigationMenuTriggerStyle(), "group flex-row items-center", current && "bg-hover/50", className)}
      >
        <Link
          href={href}
          aria-current={current ? "page" : undefined}
          {...(menu && { "aria-expanded": open, "data-state": open ? "open" : "closed" })}
        >
          {label}
          {menu && (
            <svg
              className={NAVIGATION_MENU_TRIGGER_CHEVRON}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {iconShapes("chevron-down")}
            </svg>
          )}
        </Link>
      </NavigationMenuLink>
      {menu && (
        <NavigationMenuContent className="p-1.5" onClick={() => setOpen(false)}>
          {children}
        </NavigationMenuContent>
      )}
    </NavigationMenuItem>
  );
}

export interface NavMenuListProps extends NavLinkCallbacks {
  groups: readonly NavGroup[];
  /** The router's current path — `usePathname()` in Next. */
  pathname: string;
  linkComponent?: React.ElementType;
  /** Spoken text of a numeric badge, given the real count. Default `"{n} new"`. */
  badgeLabel?: (count: number) => string;
  className?: string;
}

/**
 * Sections of rows — icon, label, badge, the description under them — for a {@link NavMenu}. Inside a
 * {@link ShellNav} (an app's element drawn in the rail) the same list sheds its descriptions and sits
 * at the rail's row size.
 */
export function NavMenuList({ groups, pathname, linkComponent, badgeLabel, onItemIntent, onNavigate, className }: NavMenuListProps) {
  const currentId = resolveActiveNavItem(groups.flatMap((g) => g.items), pathname)?.id;
  return (
    <div data-slot="nav-menu-list" className={cn("flex w-80 max-w-full flex-col gap-1 in-data-[slot=shell-nav]:w-auto", className)}>
      {groups.map((group) => (
        <NavMenuSection
          key={group.id}
          group={group}
          currentId={currentId}
          row={{ linkComponent, badgeLabel, onItemIntent, onNavigate }}
        />
      ))}
    </div>
  );
}

interface RowContext extends NavLinkCallbacks {
  linkComponent: React.ElementType | undefined;
  badgeLabel: ((count: number) => string) | undefined;
}

function NavMenuSection({ group, currentId, row }: { group: NavGroup; currentId: string | undefined; row: RowContext }) {
  const labelId = React.useId();
  return (
    <section className="flex flex-col gap-0.5">
      {group.label !== undefined && (
        <p id={labelId} className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-widest text-ink-soft">
          {group.label}
        </p>
      )}
      <ul aria-labelledby={group.label !== undefined ? labelId : undefined} className="flex flex-col gap-0.5">
        {group.items.map((item) => (
          <li key={item.id} className="flex flex-col">
            <NavMenuRow item={item} current={item.id === currentId} row={row} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NavMenuRow({ item, current, row }: { item: NavItem; current: boolean; row: RowContext }) {
  const Icon = item.icon;
  const trailing = typeof item.trailing === "function" ? item.trailing({ active: current, pending: false }) : item.trailing;
  return (
    <NavLink
      item={item}
      current={current}
      pending={false}
      linkComponent={row.linkComponent}
      onItemIntent={row.onItemIntent}
      onNavigate={row.onNavigate}
      className={cn(
        "group/row flex items-start gap-3 rounded-row px-3 py-2.5 text-sm in-data-[slot=shell-nav]:items-center in-data-[slot=shell-nav]:py-2",
        NAV_FOCUS,
        current ? CURRENT : "text-ink hover:bg-hover hover:text-primary-ink",
        item.disabled && "cursor-not-allowed opacity-(--disabled-opacity) hover:bg-transparent hover:text-ink",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4.5 shrink-0 in-data-[slot=shell-nav]:mt-0",
          current ? "text-ink" : "text-ink-soft group-hover/row:text-primary-ink",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 font-medium">
          <span className="min-w-0 truncate">{item.label}</span>
          {typeof item.badge === "number" ? (
            <NavBadge count={item.badge} {...(row.badgeLabel ? { label: row.badgeLabel } : {})} />
          ) : (
            item.badge
          )}
        </span>
        <span className="line-clamp-2 text-xs text-ink-soft in-data-[slot=shell-nav]:hidden">{item.description}</span>
      </span>
      {trailing}
    </NavLink>
  );
}
