import * as React from "react";
import { cn } from "../../lib/cn";
import { Slot } from "../../primitives/slot";
import { sizeClasses, type Size } from "../../generated/size";
import { accentFillClasses, accentOutlineClasses, type Accent } from "../../generated/accent";
import {
  BUTTON_BASE,
  BUTTON_ICON,
  buttonVariantClasses,
  type ButtonVariant,
} from "../../generated/button";

export type ButtonSize = Size;
export type { Accent, ButtonVariant };

export interface ButtonVariantsOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A square button holding a bare glyph; `size` still picks the magnitude. */
  icon?: boolean;
  /** Recolours the button at an accent rung; unset is the normal case. */
  accent?: Accent | undefined;
  className?: string;
}

/**
 * Returns the fused canonical button class string. Reused by `pagination` so a
 * non-`Button` element can adopt the same styling, mirroring Rust's
 * `button_classes`.
 *
 * The accent fuses after the variant so it recolours whatever the variant set.
 */
export function buttonVariants({
  variant = "primary",
  size = "md",
  icon = false,
  accent,
  className,
}: ButtonVariantsOptions = {}): string {
  return cn(
    BUTTON_BASE,
    buttonVariantClasses[variant],
    sizeClasses[size],
    icon ? BUTTON_ICON : undefined,
    accent === undefined ? undefined : accentClass(accent, variant),
    className,
  );
}

// Which face an accent wears is the variant's business — an outlined button tints
// what it already has, anything else repaints. Mirrors Rust's `button_accent_class`.
function accentClass(accent: Accent, variant: ButtonVariant): string {
  return variant === "outline" ? accentOutlineClasses[accent] : accentFillClasses[accent];
}

export interface ButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
  accent?: Accent;
  asChild?: boolean;
  /** Renders an `<a>` wearing the button's classes — a link that looks like a
   *  call to action is still a link. */
  href?: string;
  /** Disables it, saying why on hover: a disabled button takes no pointer, so the reason sits on a wrapper. */
  disabledReason?: string;
  /** Disables it as not built yet, saying what it will do. */
  planned?: string;
}

// `forwardRef` so `asChild` triggers (Popover, Tooltip, Dialog) get their anchor under React 18 too.
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", icon = false, accent, asChild = false, href, disabledReason, planned, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot : href !== undefined ? "a" : "button";
  const reason = planned ?? disabledReason;
  const button = (
    <Comp
      data-slot="button"
      href={href}
      ref={ref as React.Ref<never>}
      className={cn(buttonVariants({ variant, size, icon, accent }), planned !== undefined && PLANNED_FACE, className)}
      {...(reason === undefined ? {} : { disabled: true, "aria-disabled": true })}
      {...(props as Record<string, unknown>)}
    >
      {children}
      {planned !== undefined && !icon && <span className={PLANNED_TAG}>{PLANNED}</span>}
    </Comp>
  );
  if (reason === undefined) return button;
  return (
    <span data-slot="disabled-reason" title={reason} className="inline-flex">
      {button}
    </span>
  );
});

/** A control not built yet wears a dashed edge and this tag; `Planned` is the same for a section. */
export const PLANNED = "Planned";
export const PLANNED_FACE = "border border-dashed border-border";
export const PLANNED_TAG = "rounded-sm bg-muted px-1 text-[0.625rem] font-medium uppercase tracking-wide text-ink-soft";
