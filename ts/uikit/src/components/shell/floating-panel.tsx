"use client";

import * as React from "react";
import { Portal } from "../../primitives/portal";
import { UiIcon } from "../../icons/ui-icons";

export interface FloatingPanelProps {
  title: React.ReactNode;
  /** Where its top-left corner first sits, in viewport pixels; dragging by the title moves it from there. */
  at: { x: number; y: number };
  onClose: () => void;
  /** Default `"Close"`. */
  closeLabel?: string;
  children: React.ReactNode;
}

/** A non-modal window over the page, dragged by its title bar and kept inside the viewport; the page under it stays live. Its content sets its width. */
export function FloatingPanel({ title, at, onClose, closeLabel = "Close", children }: FloatingPanelProps) {
  const [pos, setPos] = React.useState(at);
  const ref = React.useRef<HTMLDivElement>(null);
  const clamp = React.useCallback((p: { x: number; y: number }) => {
    const box = ref.current?.getBoundingClientRect();
    if (box === undefined) return p;
    return { x: Math.min(Math.max(0, p.x), window.innerWidth - box.width), y: Math.min(Math.max(0, p.y), window.innerHeight - box.height) };
  }, []);
  React.useLayoutEffect(() => setPos(clamp), [clamp]);
  React.useEffect(() => {
    const onResize = () => setPos(clamp);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  return (
    <Portal>
      <div
        ref={ref}
        role="dialog"
        aria-modal={false}
        data-slot="floating-panel"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 flex max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] flex-col rounded-panel border border-border bg-popover text-ink shadow-md"
      >
        <div
          data-slot="floating-panel-title"
          onPointerDown={e => {
            if ((e.target as HTMLElement).closest("button") !== null) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const from = { x: e.clientX - pos.x, y: e.clientY - pos.y };
            const target = e.currentTarget;
            const move = (m: PointerEvent) => setPos(clamp({ x: m.clientX - from.x, y: m.clientY - from.y }));
            target.addEventListener("pointermove", move);
            target.addEventListener("pointerup", () => target.removeEventListener("pointermove", move), { once: true });
          }}
          className="flex h-(--control-h-sm) shrink-0 cursor-grab touch-none items-center gap-2 border-b border-border pr-1 pl-3 text-body-s font-medium select-none active:cursor-grabbing"
        >
          <span className="flex-1 truncate">{title}</span>
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
            className="flex size-(--control-h-2xs) items-center justify-center rounded-control text-ink-soft hover:bg-hover hover:text-ink"
          >
            <UiIcon name="x" className="size-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </Portal>
  );
}
