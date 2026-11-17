"use client";

import * as React from "react";
import { Portal } from "../../primitives/portal";
import { UiIcon } from "../../icons/ui-icons";

/** What of its area stays in the viewport however it is dragged. */
const KEPT = 0.25;

export interface FloatingPanelProps {
  title: React.ReactNode;
  /** Where its top-left corner first sits, in viewport pixels; dragging by the title moves it from there. */
  at: { x: number; y: number };
  onClose: () => void;
  /** Default `"Close"`. */
  closeLabel?: string;
  children: React.ReactNode;
}

/** A non-modal window over the page, dragged by its title bar, partly past the viewport's left, right and bottom edges; the page under it stays live. Focused when it opens, Escape within it closes it. Its content sets its width. */
export function FloatingPanel({ title, at, onClose, closeLabel = "Close", children }: FloatingPanelProps) {
  const [pos, setPos] = React.useState(at);
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const clamp = React.useCallback((p: { x: number; y: number }) => {
    const box = ref.current?.getBoundingClientRect();
    if (box === undefined) return p;
    const title = ref.current!.firstElementChild!.getBoundingClientRect().height;
    // the top edge never leaves: the title bar is what drags it back
    const x = Math.min(Math.max(box.width * KEPT - box.width, p.x), window.innerWidth - box.width * KEPT);
    const y = Math.min(Math.max(0, p.y), window.innerHeight - Math.max(title, box.height * KEPT));
    const left = Math.max(0, -x);
    const right = Math.max(0, x + box.width - window.innerWidth);
    const below = Math.max(0, y + box.height - window.innerHeight);
    const ox = (left + right) / box.width;
    const oy = below / box.height;
    if ((1 - ox) * (1 - oy) >= KEPT) return { x, y };
    // past a corner: both overhangs shrunk by the one factor t that leaves KEPT of its area in, (1 - t·ox)(1 - t·oy) = KEPT
    const s = ox + oy;
    const t = (s - Math.sqrt(s * s - 4 * ox * oy * (1 - KEPT))) / (2 * ox * oy);
    return { x: x + (left - right) * (1 - t), y: y - below * (1 - t) };
  }, []);
  React.useLayoutEffect(() => setPos(clamp), [clamp]);
  React.useEffect(() => ref.current?.focus({ preventScroll: true }), []);
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
        aria-labelledby={titleId}
        tabIndex={-1}
        // DOM containment, not React's: an Escape in a dialog portalled from its content is that dialog's
        onKeyDown={e => {
          if (e.key === "Escape" && e.currentTarget.contains(e.target as Node)) onClose();
        }}
        data-slot="floating-panel"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 flex max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] flex-col rounded-panel border border-border bg-popover text-ink shadow-md outline-none"
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
          <span id={titleId} className="flex-1 truncate">{title}</span>
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
