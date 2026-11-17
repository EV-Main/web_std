"use client";

import * as React from "react";
import type { DataSlot } from "../generated/slot";
import { Slot } from "./slot";

/** The open state an overlay's root shares with its trigger. */
export interface Openable {
  open: boolean;
  setOpen: (next: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
}

export interface OpenerProps extends React.ComponentProps<"button"> {
  asChild?: boolean;
}

/** An overlay's trigger: a click opens `state`'s overlay, after the consumer's `onClick`. */
export function Opener({ state: { open, setOpen, triggerRef }, dataSlot, asChild = false, onClick, ...props }: OpenerProps & { state: Openable; dataSlot: DataSlot }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot={dataSlot}
      aria-expanded={open}
      ref={triggerRef as React.Ref<HTMLButtonElement>}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e);
        setOpen(true);
      }}
      {...(props as Record<string, unknown>)}
    />
  );
}
