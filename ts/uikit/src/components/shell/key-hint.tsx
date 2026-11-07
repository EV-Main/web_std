import type { Hint } from "@evinvest/keymap";
import * as React from "react";
import { KEY_HINT, KEY_HINT_PREFIX, KEY_HINT_ROW } from "../../generated/key-hint";
import { cn } from "../../lib/cn";
import { Kbd } from "../atomic/kbd";

export interface KeyHintProps extends React.ComponentProps<"div"> {
  hint: Hint;
}

/** The which-key popup for the scope a chord has opened: what each next key does. */
export function KeyHint({ hint, className, ...props }: KeyHintProps) {
  return (
    <div data-slot="key-hint" data-enter="rise" className={cn(KEY_HINT, className)} {...props}>
      <div className={KEY_HINT_PREFIX}>{hint.prefix}</div>
      {hint.rows.map(row => (
        <div key={row.chord} data-slot="key-hint-row" data-scope={row.scope ? "" : undefined} className={KEY_HINT_ROW}>
          <Kbd>{row.chord}</Kbd>
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}
