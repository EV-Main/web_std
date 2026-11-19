import type * as React from "react";
import { cn } from "../../lib/cn";
import { PLANNED, PLANNED_TAG } from "./button";

export interface PlannedProps extends React.ComponentProps<"section"> {
  /** What will be here: shown under the tag and on hover. */
  what: string;
}

/**
 * A section not built yet. Its children are a mock of what it will become, drawn
 * dimmed and inert so the layout reads true while nothing in it can be used.
 */
export function Planned({ what, className, children, ...props }: PlannedProps) {
  return (
    <section data-slot="planned" title={what} className={cn("relative flex flex-col gap-2 rounded-panel border border-dashed border-border p-3", className)} {...props}>
      <p className="flex items-center gap-2 text-xs text-ink-soft">
        <span className={PLANNED_TAG}>{PLANNED}</span>
        {what}
      </p>
      <div inert className="flex flex-col gap-2 opacity-(--disabled-opacity) select-none">
        {children}
      </div>
    </section>
  );
}
