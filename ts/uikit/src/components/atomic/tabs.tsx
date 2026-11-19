"use client";

import * as React from "react";
import { cn } from "../../lib/cn";
import { useControllableState } from "../../primitives/use-controllable-state";
import { useRovingFocus } from "../../primitives/use-roving-focus";
import { TABS_ROOT, TABS_LIST, TABS_TRIGGER, TABS_CONTENT } from "../../generated/tabs";
import type { Orientation } from "../../generated/orientation";
import { PLANNED, PLANNED_FACE, PLANNED_TAG } from "./button";


interface TabsContextValue {
  value: string;
  setValue: (next: string) => void;
  orientation: Orientation;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error("Tabs parts must be used within <Tabs>");
  return ctx;
}

export interface TabsProps
  extends Omit<React.ComponentProps<"div">, "onChange"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: Orientation;
}

export function Tabs({
  className,
  value,
  defaultValue = "",
  onValueChange,
  orientation = "horizontal",
  children,
  ...props
}: TabsProps) {
  const [active, setValue] = useControllableState<string>({
    ...(value !== undefined ? { value } : {}),
    defaultValue,
    ...(onValueChange ? { onChange: onValueChange } : {}),
  });
  return (
    <TabsContext.Provider value={{ value: active, setValue, orientation }}>
      <div
        data-slot="tabs"
        data-orientation={orientation}
        className={cn(TABS_ROOT, className)}
        {...props}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  className,
  children,
  onKeyDown,
  ...props
}: React.ComponentProps<"div">) {
  const { orientation } = useTabs();
  const items = React.Children.toArray(children);
  const { activeIndex, setActiveIndex, onKeyDown: rovingKeyDown } =
    useRovingFocus({
      count: items.length,
      orientation: orientation === "vertical" ? "vertical" : "horizontal",
    });
  return (
    <div
      role="tablist"
      data-slot="tabs-list"
      aria-orientation={orientation}
      className={cn(TABS_LIST, className)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        rovingKeyDown(e);
      }}
      {...props}
    >
      {items.map((child, index) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<TabsTriggerInternal>, {
              __index: index,
              __isFocusItem: index === activeIndex,
              __onFocusItem: () => setActiveIndex(index),
            })
          : child,
      )}
    </div>
  );
}

interface TabsTriggerInternal {
  __index?: number;
  __isFocusItem?: boolean;
  __onFocusItem?: () => void;
}

export interface TabsTriggerProps
  extends React.ComponentProps<"button">,
    TabsTriggerInternal {
  value: string;
  /** Disables it, saying why on hover. */
  disabledReason?: string;
  /** Disables it as not built yet, saying what it will hold. */
  planned?: string;
}

export function TabsTrigger({
  className,
  value,
  onClick,
  onFocus,
  __isFocusItem,
  __onFocusItem,
  disabledReason,
  planned,
  children,
  disabled,
  ...props
}: TabsTriggerProps) {
  const { value: active, setValue } = useTabs();
  const selected = active === value;
  const reason = planned ?? disabledReason;
  const trigger = (
    <button
      type="button"
      role="tab"
      data-slot="tabs-trigger"
      data-state={selected ? "active" : "inactive"}
      aria-selected={selected}
      tabIndex={__isFocusItem ? 0 : -1}
      className={cn(TABS_TRIGGER, planned !== undefined && PLANNED_FACE, className)}
      disabled={disabled === true || reason !== undefined}
      onClick={(e) => {
        onClick?.(e);
        __onFocusItem?.();
        setValue(value);
      }}
      onFocus={(e) => {
        onFocus?.(e);
        __onFocusItem?.();
      }}
      {...props}
    >
      {children}
      {planned !== undefined && <span className={PLANNED_TAG}>{PLANNED}</span>}
    </button>
  );
  if (reason === undefined) return trigger;
  return (
    <span data-slot="disabled-reason" title={reason} className="inline-flex flex-1">
      {trigger}
    </span>
  );
}

export interface TabsContentProps extends React.ComponentProps<"div"> {
  value: string;
}

export function TabsContent({
  className,
  value,
  children,
  ...props
}: TabsContentProps) {
  const { value: active } = useTabs();
  if (active !== value) return null;
  return (
    <div
      role="tabpanel"
      data-slot="tabs-content"
      data-state="active"
      className={cn(TABS_CONTENT, className)}
      {...props}
    >
      {children}
    </div>
  );
}
