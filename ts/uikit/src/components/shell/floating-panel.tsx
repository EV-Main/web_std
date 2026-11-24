"use client";

import * as React from "react";
import { Portal } from "../../primitives/portal";
import { useDismissableLayer } from "../../primitives/dismissable-layer";
import { mergeRefs } from "../../primitives/merge-refs";
import { UiIcon } from "../../icons/ui-icons";
import type { IconName } from "../../generated/icons";

/** What of its area stays in the viewport however it is dragged. */
const KEPT = 0.25;
const MIN = { width: 240, height: 120 };

/** Its size once resized: `height: null` when only its width was, its content then sets the height. */
export type PanelSize = { width: number; height: number | null };

/** Where it sits, in viewport pixels, and its size; `size: null` until resized, its content's. */
export interface Placement {
  x: number;
  y: number;
  size: PanelSize | null;
}

export interface FloatingPanelHandle {
  /** To the middle of the viewport, at its size. */
  center: () => void;
}

export interface FloatingPanelProps {
  title: React.ReactNode;
  /** Where its top-left corner first sits; dragging by the title moves it from there. */
  at: { x: number; y: number };
  /** Its first size; absent, its content's (or `width`'s) until resized. */
  size?: PanelSize | null;
  /** Its content's width, in px, until it is resized. */
  width?: number;
  /** Told where it was left: after a drag, a resize or a centering. */
  onPlaced?: (placement: Placement) => void;
  onClose: () => void;
  /** A minimize in its title bar, when given. */
  onMinimize?: () => void;
  /** Out of sight, its content mounted and its place kept. */
  minimized?: boolean;
  /** Buttons in its title bar, after the minimize, before the close. */
  actions?: React.ReactNode;
  handle?: React.Ref<FloatingPanelHandle>;
  /** Default `"Close"`. */
  closeLabel?: string;
  /** Default `"Minimize"`. */
  minimizeLabel?: string;
  /** Default `"Center"`. */
  centerLabel?: string;
  /** Default `"Resize"`. */
  resizeLabel?: string;
  children: React.ReactNode;
}

const BAR_BUTTON = "flex size-(--control-h-2xs) items-center justify-center rounded-control text-ink-soft hover:bg-hover hover:text-ink";

function BarButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={BAR_BUTTON}>
      <UiIcon name={icon} className="size-4" />
    </button>
  );
}

/** Follows the pointer from `e` until it is let go, then `done`. */
function track(e: React.PointerEvent<HTMLElement>, move: (m: PointerEvent) => void, done: () => void) {
  e.preventDefault();
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  target.addEventListener("pointermove", move);
  target.addEventListener(
    "pointerup",
    () => {
      target.removeEventListener("pointermove", move);
      done();
    },
    { once: true },
  );
}

/**
 * A non-modal window over the page, dragged by its title bar, partly past the viewport's left and right edges, resized by its right
 * and bottom edges and its corner, which never leave the viewport's bottom: dragged lower, it is cut shorter; the page under it stays live. Focused when it opens, Escape closes it while it is the
 * top of the dismiss stack.
 */
export function FloatingPanel({
  title,
  at,
  size: firstSize = null,
  width,
  onPlaced,
  onClose,
  onMinimize,
  minimized = false,
  actions,
  handle,
  closeLabel = "Close",
  minimizeLabel = "Minimize",
  centerLabel = "Center",
  resizeLabel = "Resize",
  children,
}: FloatingPanelProps) {
  const [pos, setPos] = React.useState(at);
  const [size, setSize] = React.useState<PanelSize | null>(firstSize);
  const ref = React.useRef<HTMLDivElement>(null);
  const layer = useDismissableLayer({ enabled: !minimized, onDismiss: e => !e.defaultPrevented && onClose(), pointerOutside: false });
  const titleId = React.useId();
  const placed = React.useRef<Placement>({ ...at, size: firstSize });
  React.useLayoutEffect(() => {
    placed.current = { ...pos, size };
  });
  const report = React.useRef(onPlaced);
  React.useEffect(() => {
    report.current = onPlaced;
  });
  const told = () => report.current?.(placed.current);
  const clamp = React.useCallback((p: { x: number; y: number }) => {
    const box = ref.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return p; // minimized: no box
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
  React.useLayoutEffect(() => {
    if (!minimized) setPos(clamp);
  }, [clamp, minimized]);
  React.useEffect(() => {
    if (!minimized) ref.current?.focus({ preventScroll: true });
  }, [minimized]);
  React.useEffect(() => {
    const onResize = () => setPos(clamp);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);
  const center = React.useCallback(() => {
    const box = ref.current!.getBoundingClientRect();
    const next = { x: Math.max(0, (window.innerWidth - box.width) / 2), y: Math.max(0, (window.innerHeight - box.height) / 2) };
    setPos(next);
    placed.current = { ...placed.current, ...next };
    report.current?.(placed.current);
  }, []);
  React.useImperativeHandle(handle, () => ({ center }), [center]);
  const resize = (axes: { x: boolean; y: boolean }) => (e: React.PointerEvent<HTMLElement>) => {
    const box = ref.current!.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY };
    const height = size?.height ?? null;
    track(
      e,
      m =>
        setSize({
          width: axes.x ? Math.min(Math.max(MIN.width, box.width + m.clientX - from.x), window.innerWidth - 16) : box.width,
          height: axes.y ? Math.min(Math.max(MIN.height, box.height + m.clientY - from.y), window.innerHeight - 16) : height,
        }),
      told,
    );
  };

  return (
    <Portal>
      <div
        ref={mergeRefs(ref, layer)}
        role="dialog"
        aria-modal={false}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-slot="floating-panel"
        style={{ display: minimized ? "none" : undefined, left: pos.x, top: pos.y, width: size?.width, height: size?.height ?? undefined, maxHeight: `calc(100vh - ${Math.max(0, pos.y)}px - 0.5rem)` }}
        className="fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col rounded-panel border border-border bg-popover text-ink shadow-md outline-none"
      >
        <div
          data-slot="floating-panel-title"
          onPointerDown={e => {
            if ((e.target as HTMLElement).closest("button") !== null) return;
            const from = { x: e.clientX - pos.x, y: e.clientY - pos.y };
            track(e, m => setPos(clamp({ x: m.clientX - from.x, y: m.clientY - from.y })), told);
          }}
          className="flex h-(--control-h-sm) shrink-0 cursor-grab touch-none items-center gap-1 border-b border-border pr-1 pl-3 text-body-s font-medium select-none active:cursor-grabbing"
        >
          <span id={titleId} className="flex-1 truncate">
            {title}
          </span>
          <BarButton icon="focus" label={centerLabel} onClick={center} />
          {onMinimize && <BarButton icon="minus" label={minimizeLabel} onClick={onMinimize} />}
          {actions}
          <BarButton icon="x" label={closeLabel} onClick={onClose} />
        </div>
        <div className="min-h-0 max-w-full flex-1 overflow-y-auto" style={{ width: size === null ? width : undefined }}>
          {children}
        </div>
        <div aria-hidden onPointerDown={resize({ x: true, y: false })} className="absolute top-(--control-h-sm) right-0 bottom-4 w-1.5 cursor-ew-resize touch-none" />
        <div aria-hidden onPointerDown={resize({ x: false, y: true })} className="absolute right-4 bottom-0 left-0 h-1.5 cursor-ns-resize touch-none" />
        <div
          title={resizeLabel}
          onPointerDown={resize({ x: true, y: true })}
          className="absolute right-0 bottom-0 flex size-4 cursor-nwse-resize touch-none items-end justify-end text-ink-soft opacity-60 hover:opacity-100"
        >
          <UiIcon name="corner-grip" className="size-4" />
        </div>
      </div>
    </Portal>
  );
}
