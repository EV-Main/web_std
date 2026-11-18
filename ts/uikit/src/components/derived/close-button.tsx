"use client";

import { UiIcon } from "../../icons/ui-icons";
import { useDismissableLayer } from "../../primitives/dismissable-layer";
import { Button, type ButtonProps } from "../atomic/button";

export interface CloseButtonProps extends Omit<ButtonProps, "onClick" | "children" | "icon" | "variant" | "asChild" | "href"> {
  onClose: () => void;
  /** Its accessible name and tooltip. */
  label: string;
}

/**
 * The X that closes the surface it sits on. Escape presses it too while it is
 * the top of the dismiss stack, so a menu or dialog opened after it takes
 * Escape first; an Escape whose default a handler on its way prevented is that
 * handler's.
 */
export function CloseButton({ onClose, label, type = "button", ...props }: CloseButtonProps) {
  const layer = useDismissableLayer({
    enabled: true,
    onDismiss: (e) => {
      if (!e.defaultPrevented) onClose();
    },
    pointerOutside: false,
  });
  return (
    <span ref={layer} className="contents">
      <Button type={type} variant="ghost" icon aria-label={label} title={label} onClick={onClose} {...props}>
        <UiIcon name="x" />
      </Button>
    </span>
  );
}
