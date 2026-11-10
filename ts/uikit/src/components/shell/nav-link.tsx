"use client";

import * as React from "react";
import { anchorTargetProps, isPlainLeftClick, type NavItem } from "./nav-model";

// The ring is the solid token, never a tint — at 50% it composites under the 3:1
// non-text floor. The offset keeps it legible around the marked row, whose fill
// is that same hue.
export const NAV_FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary";
export const ROW = "flex items-center gap-3 rounded-row px-3 py-2 text-sm";
// a tint and an edge, not a fill: the current row is told apart, not shouted
export const CURRENT = "relative bg-selected text-ink before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary";

export interface NavLinkCallbacks {
  /** Hover or focus on an item — the moment to prefetch its route. */
  onItemIntent?: ((item: NavItem) => void) | undefined;
  /** A plain left click on an in-app item, after it is marked pending. */
  onNavigate?: ((item: NavItem) => void) | undefined;
}

interface NavLinkProps extends NavLinkCallbacks {
  item: NavItem;
  current: boolean;
  pending: boolean;
  linkComponent: React.ElementType | undefined;
  /** Unset where nothing waits for the route: a menu closes on the click. */
  markPending?: ((id: string) => void) | undefined;
  className: string;
  title?: string | undefined;
  children: React.ReactNode;
}

/**
 * The anchor (or the disabled stand-in) under a rail row and a tab: picks the
 * element, wires the optimistic mark and the intent/navigate callbacks, and
 * carries `aria-current`, which is also what the rail's marker measures.
 */
export function NavLink({
  item,
  current,
  pending,
  linkComponent,
  markPending,
  onItemIntent,
  onNavigate,
  className,
  title,
  children,
}: NavLinkProps) {
  if (item.disabled) {
    return (
      <span data-slot="nav-link" aria-disabled="true" title={title} className={className}>
        {children}
      </span>
    );
  }
  const Comp: React.ElementType = item.external ? "a" : (linkComponent ?? "a");
  const intent = onItemIntent && (() => onItemIntent(item));
  return (
    <Comp
      data-slot="nav-link"
      data-pending={pending ? "true" : undefined}
      href={item.href}
      title={title}
      aria-current={current ? "page" : undefined}
      className={className}
      onPointerEnter={intent}
      onFocus={intent}
      onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
        if (item.external || !isPlainLeftClick(e)) return;
        markPending?.(item.id);
        onNavigate?.(item);
      }}
      {...anchorTargetProps(item)}
    >
      {children}
    </Comp>
  );
}

/** The row's tooltip: the label itself when it is plain text, so a truncated one stays readable. */
export function labelTitle(label: React.ReactNode): string | undefined {
  return typeof label === "string" ? label : undefined;
}
