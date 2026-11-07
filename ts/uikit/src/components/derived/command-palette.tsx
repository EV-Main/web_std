"use client";

import type { Trigger } from "@evinvest/keymap";
import * as React from "react";
import {
  COMMAND_PALETTE_COMMAND,
  COMMAND_PALETTE_CONTENT,
  COMMAND_PALETTE_HINT,
  COMMAND_PALETTE_HINTS,
  COMMAND_PALETTE_LABEL,
  COMMAND_PALETTE_LIST,
  COMMAND_PALETTE_TITLE,
  COMMAND_PALETTE_LABELS,
} from "../../generated/command-palette";
import { cn } from "../../lib/cn";
import { useControllableState } from "../../primitives/use-controllable-state";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "../atomic/command";
import { Dialog, DialogContent, DialogTitle } from "../atomic/dialog";
import { Kbd } from "../atomic/kbd";
import { useBinding } from "../shell/keymap";

export interface CommandPaletteItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Shown at the row end, e.g. "⌘N". */
  shortcut?: string;
  /** Extra words the search matches besides the label. */
  keywords?: readonly string[];
  disabled?: boolean;
  onSelect: () => void;
}

export interface CommandPaletteGroup {
  id: string;
  heading?: string;
  items: readonly CommandPaletteItem[];
}

export interface CommandPaletteLabels {
  /** Names the dialog for assistive tech. Default `"Command palette"`. */
  title?: string;
  placeholder?: string;
  empty?: string;
  navigate?: string;
  select?: string;
  close?: string;
}

export interface CommandPaletteProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  groups: readonly CommandPaletteGroup[];
  labels?: CommandPaletteLabels;
  className?: string;
}

// Built on Dialog + Command rather than the kit's CommandDialog: that one has no accessible
// name and no footer, and both need Dialog's title and focus wiring.
/**
 * Search-and-run over a list of actions. Choosing a row runs it and closes the
 * palette. Pair it with `useCommandPaletteShortcut` for ⌘K / Ctrl+K.
 */
export function CommandPalette({
  open,
  defaultOpen = false,
  onOpenChange,
  groups,
  labels = {},
  className,
}: CommandPaletteProps) {
  const [isOpen, setOpen] = useControllableState<boolean>({
    ...(open !== undefined ? { value: open } : {}),
    defaultValue: defaultOpen,
    ...(onOpenChange ? { onChange: onOpenChange } : {}),
  });
  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className={cn(COMMAND_PALETTE_CONTENT, className)}
      >
        <DialogTitle className={COMMAND_PALETTE_TITLE}>{labels.title ?? COMMAND_PALETTE_LABELS.title}</DialogTitle>
        <Command className={COMMAND_PALETTE_COMMAND}>
          <CommandInput placeholder={labels.placeholder ?? COMMAND_PALETTE_LABELS.placeholder} />
          <CommandList className={COMMAND_PALETTE_LIST}>
            <CommandEmpty>{labels.empty ?? COMMAND_PALETTE_LABELS.empty}</CommandEmpty>
            {groups.map((group, i) => (
              <React.Fragment key={group.id}>
                {i > 0 && <CommandSeparator />}
                <CommandGroup {...(group.heading !== undefined ? { heading: group.heading } : {})}>
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={[item.label, ...(item.keywords ?? [])].join(" ")}
                      disabled={item.disabled ?? false}
                      onSelect={() => {
                        setOpen(false);
                        item.onSelect();
                      }}
                    >
                      {item.icon}
                      <span className={COMMAND_PALETTE_LABEL}>{item.label}</span>
                      {item.shortcut !== undefined && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </React.Fragment>
            ))}
          </CommandList>
        </Command>
        <div
          data-slot="command-palette-hints"
          className={COMMAND_PALETTE_HINTS}
        >
          <span className={COMMAND_PALETTE_HINT}>
            <Kbd>↑↓</Kbd>
            {labels.navigate ?? COMMAND_PALETTE_LABELS.navigate}
          </span>
          <span className={COMMAND_PALETTE_HINT}>
            <Kbd>↵</Kbd>
            {labels.select ?? COMMAND_PALETTE_LABELS.select}
          </span>
          <span className={COMMAND_PALETTE_HINT}>
            <Kbd>esc</Kbd>
            {labels.close ?? COMMAND_PALETTE_LABELS.close}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** ⌘K on macOS, Ctrl+K elsewhere. */
export const COMMAND_PALETTE: Trigger = { other: { key: "k", ctrl: true }, mac: { key: "k", meta: true } };

/** Binds `onTrigger` to `COMMAND_PALETTE` in the page's keymap, globally, while `enabled`. */
export function useCommandPaletteShortcut(onTrigger: () => void, enabled = true, label: string = COMMAND_PALETTE_LABELS.title): void {
  useBinding({ on: COMMAND_PALETTE, run: { id: "command-palette", label, run: enabled ? onTrigger : null } }, "root");
}
