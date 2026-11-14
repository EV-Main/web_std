"use client";

import * as React from "react";
import { cn } from "../../lib/cn";
import { toneClasses } from "../../generated/tone";
import { iconShapes } from "../../icons/icon-shapes";
import { Button } from "../atomic/button";
import { Checkbox } from "../atomic/checkbox";
import { Kbd } from "../atomic/kbd";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../atomic/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "../atomic/popover";
import { FloatingPanel } from "./floating-panel";
import { useKeymap } from "./keymap";
import { TriangleAlertIcon } from "./shell-icons";

interface HotbarActionBase {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** The `id` of the keymap leaf that runs it too (`useBinding`); its keys show in a `Kbd` while it is bound. */
  binding?: string;
  /** A toggle that is on — the agent connected, a map layer shown. The app owns the state. */
  pressed?: boolean;
  /** `false` lists it only under Customize until the user pins it. Default pinned. */
  pinned?: boolean;
  /** A compact state line on hover, while its panel is closed. */
  preview?: React.ReactNode;
}

/** Either runs on a press, or opens its `panel` above the bar, whose footer pops it out into a `FloatingPanel` or unpins it. A panel sets its own width. */
export type HotbarAction = HotbarActionBase &
  ({ onSelect: () => void; panel?: never } | { panel: React.ReactNode; onSelect?: never });

export interface HotbarLabels {
  /** Accessible name of the strip. Default `"Hotbar"`. */
  region?: string;
  /** The customize button. Default `"Customize"`. */
  customize?: string;
  /** Default `"Customize hotbar"`. */
  title?: string;
  /** Default `"Pinned actions show in the bar and in the mobile chip row."`. */
  description?: string;
  /** Default `"Reset to default"`. */
  reset?: string;
  /** Default `"Done"`. */
  done?: string;
  /** A panel's footer. Default `"Hide from hotbar"`. */
  hide?: string;
  /** A panel's footer: into a window of its own. Default `"Pop out"`. */
  popOut?: string;
  /** A popped-out panel's close button. Default `"Close"`. */
  close?: string;
}

export interface HotbarProps extends Omit<React.ComponentProps<"section">, "children"> {
  /** Every action the app offers, in bar order. */
  actions: readonly HotbarAction[];
  /** `StatusItem`s at the end of the wide strip. */
  status?: React.ReactNode;
  /** An urgent level: replaces the actions with its message until the app clears it. */
  takeover?: { tone: "warn" | "error"; message: React.ReactNode; action?: React.ReactNode };
  labels?: HotbarLabels;
}

const STORAGE_KEY = "ev-hotbar";
/** The user's pins that differ from an action's default, by action id. */
type Overrides = Readonly<Record<string, boolean>>;
const NO_OVERRIDES: Overrides = {};
let snapshot: { raw: string | null; value: Overrides } = { raw: null, value: NO_OVERRIDES };
const listeners = new Set<() => void>();

function readOverrides(): Overrides {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === snapshot.raw) return snapshot.value;
  const value: unknown = raw === null ? NO_OVERRIDES : JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.values(value).some(v => typeof v !== "boolean"))
    throw new Error(`localStorage["${STORAGE_KEY}"] is not an {actionId: boolean} map: ${raw}`);
  snapshot = { raw, value: value as Overrides };
  return snapshot.value;
}

function writeOverrides(next: Overrides) {
  if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  listeners.forEach(l => l());
}

function subscribeOverrides(listener: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The bottom strip of a terminal-style app: pinned actions with their keys,
 * a customize popover, live status at the end. Position-agnostic — the app docks
 * it. Below a 64rem strip it turns into a sideways-scrolling chip row with no
 * status. Which actions are pinned is the user's, kept in this browser.
 */
export function Hotbar({ actions, status, takeover, labels = {}, className, ...props }: HotbarProps) {
  const ids = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.id)) throw new Error(`Hotbar: two actions have the id "${action.id}"`);
    ids.add(action.id);
  }
  const { bound } = useKeymap();
  const keys = (action: HotbarAction) => (action.binding === undefined ? undefined : bound.get(action.binding)?.sequence);

  const overrides = React.useSyncExternalStore(subscribeOverrides, readOverrides, () => NO_OVERRIDES);
  const isPinned = (action: HotbarAction) => overrides[action.id] ?? action.pinned ?? true;
  const setPinned = (action: HotbarAction, pinned: boolean) => {
    const next: Record<string, boolean> = { ...overrides };
    delete next[action.id];
    if (pinned !== (action.pinned ?? true)) next[action.id] = pinned;
    writeOverrides(next);
  };

  const [customizing, setCustomizing] = React.useState(false);
  /** The panels popped out, where each first sat. */
  const [popped, setPopped] = React.useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const popIn = (id: string) =>
    setPopped(p => {
      const next = new Map(p);
      next.delete(id);
      return next;
    });

  return (
    <section
      data-slot="hotbar"
      aria-label={labels.region ?? "Hotbar"}
      className={cn(
        "@container border-t border-border-subtle bg-background",
        takeover && [toneClasses[takeover.tone], "border-(color:--tone-edge) bg-[image:linear-gradient(var(--tone-wash),var(--tone-wash))]"],
        className,
      )}
      {...props}
    >
      <div className="flex h-(--control-h-touch) items-center gap-2 overflow-x-auto px-3 @5xl:h-(--control-h) @5xl:gap-1.5 @5xl:overflow-visible">
        {takeover ? (
          <div data-slot="hotbar-takeover" role="alert" className="flex min-w-0 items-center gap-2 text-body-s font-medium text-(color:--tone-ink)">
            <TriangleAlertIcon className="size-4 shrink-0" />
            <span className="truncate">{takeover.message}</span>
            {takeover.action}
          </div>
        ) : (
          <>
            {actions.filter(isPinned).map(action => (
              <HotbarItem
                key={action.id}
                action={action}
                keys={keys(action)}
                labels={{ hide: labels.hide ?? "Hide from hotbar", popOut: labels.popOut ?? "Pop out" }}
                popped={popped.has(action.id)}
                onPopOut={at => setPopped(p => new Map(p).set(action.id, at))}
                onPopIn={() => popIn(action.id)}
                onHide={() => setPinned(action, false)}
              />
            ))}
            <span aria-hidden className="hidden h-4 w-px shrink-0 bg-border @5xl:block" />
            <Popover open={customizing} onOpenChange={setCustomizing}>
              <PopoverTrigger type="button" data-slot="hotbar-customize" className={cn(ITEM, "@5xl:w-(--control-h-2xs) @5xl:justify-center @5xl:px-0")}>
                <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {iconShapes("sliders-horizontal")}
                </svg>
                <span className="@5xl:sr-only">{labels.customize ?? "Customize"}</span>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-80 p-0">
                <div className="flex flex-col gap-0.5 px-3 pt-3 pb-2">
                  <p className="text-body-l font-medium">{labels.title ?? "Customize hotbar"}</p>
                  <p className="text-caption text-ink-soft">
                    {labels.description ?? "Pinned actions show in the bar and in the mobile chip row."}
                  </p>
                </div>
                <ul className="flex flex-col px-1 pb-1">
                  {actions.map(action => (
                    <li key={action.id}>
                      <label className="flex h-(--control-h-sm) cursor-pointer items-center gap-2.5 rounded-control px-2 text-body text-ink-mid hover:bg-hover">
                        <Checkbox checked={isPinned(action)} onCheckedChange={pinned => setPinned(action, pinned)} />
                        <action.icon className="size-4 shrink-0" />
                        <span className="flex-1 truncate">{action.label}</span>
                        {keys(action) && <Kbd>{keys(action)}</Kbd>}
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t border-border px-3 py-2">
                  <Button variant="ghost" size="sm" onClick={() => writeOverrides(NO_OVERRIDES)}>
                    {labels.reset ?? "Reset to default"}
                  </Button>
                  <Button size="sm" onClick={() => setCustomizing(false)}>
                    {labels.done ?? "Done"}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </>
        )}
        {status != null && (
          <div data-slot="hotbar-status" className="ml-auto hidden shrink-0 items-center @5xl:flex">
            {status}
          </div>
        )}
      </div>
      {actions.map(action => {
        const at = popped.get(action.id);
        return (
          at !== undefined &&
          action.panel !== undefined && (
            <FloatingPanel key={action.id} title={action.label} at={at} closeLabel={labels.close ?? "Close"} onClose={() => popIn(action.id)}>
              {action.panel}
            </FloatingPanel>
          )
        );
      })}
    </section>
  );
}

function HotbarItem({
  action,
  keys,
  labels,
  popped,
  onPopOut,
  onPopIn,
  onHide,
}: {
  action: HotbarAction;
  keys: string | undefined;
  labels: { hide: string; popOut: string };
  popped: boolean;
  onPopOut: (at: { x: number; y: number }) => void;
  onPopIn: () => void;
  onHide: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const face = (
    <>
      <action.icon className="size-4 shrink-0" />
      {action.label}
      {keys && <Kbd className="hidden @5xl:inline-flex">{keys}</Kbd>}
    </>
  );
  const button =
    action.panel === undefined || popped ? (
      <button
        type="button"
        data-slot="hotbar-action"
        aria-pressed={popped || action.pressed}
        onClick={action.panel === undefined ? action.onSelect : onPopIn}
        className={cn(ITEM, (popped || action.pressed) && PRESSED)}
      >
        {face}
      </button>
    ) : (
      <PopoverTrigger type="button" data-slot="hotbar-action" aria-pressed={action.pressed} className={cn(ITEM, action.pressed && PRESSED)}>
        {face}
      </PopoverTrigger>
    );
  const previewed =
    action.preview === undefined ? (
      button
    ) : (
      <HoverCard open={hovered && !open} onOpenChange={setHovered}>
        {/* its own element: two triggers' anchor refs on one would leave the panel unanchored */}
        <HoverCardTrigger asChild>
          <span className="inline-flex shrink-0">{button}</span>
        </HoverCardTrigger>
        <HoverCardContent side="top" align="start" data-slot="hotbar-preview" className="w-auto max-w-80 px-2.5 py-1.5 text-body-s">
          {action.preview}
        </HoverCardContent>
      </HoverCard>
    );
  if (action.panel === undefined || popped) return previewed;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {previewed}
      <PopoverContent side="top" align="start" data-slot="hotbar-panel" className="w-auto p-0">
        {action.panel}
        <div className="flex border-t border-border p-1">
          <button
            type="button"
            onClick={e => {
              const box = e.currentTarget.closest('[data-slot="hotbar-panel"]')!.getBoundingClientRect();
              setOpen(false);
              onPopOut({ x: box.left, y: box.top });
            }}
            className={FOOTER}
          >
            {labels.popOut}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onHide();
            }}
            className={FOOTER}
          >
            {labels.hide}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const FOOTER = "flex h-(--control-h-sm) flex-1 items-center rounded-control px-2 text-body-s text-ink-soft hover:bg-hover hover:text-ink";

// A chip below the container breakpoint, a ghost row item from it up.
const ITEM =
  "inline-flex h-(--control-h-xs) shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip border border-border bg-secondary pr-3 pl-2 text-body-s text-ink-mid transition-colors outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring " +
  "@5xl:h-(--control-h-2xs) @5xl:rounded-control @5xl:border-transparent @5xl:bg-transparent @5xl:px-2 @5xl:hover:bg-hover";
const PRESSED = `${toneClasses.primary} border-(color:--tone-edge) bg-(color:--tone-fill) text-(color:--tone-ink) hover:text-(color:--tone-ink) @5xl:border-(color:--tone-edge) @5xl:bg-(color:--tone-fill)`;
