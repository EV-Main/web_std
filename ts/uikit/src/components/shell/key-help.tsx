"use client";

import type { HelpRow } from "@evinvest/keymap";
import * as React from "react";
import { KEY_HELP_LABEL, KEY_HELP_LABELS, KEY_HELP_LIST, KEY_HELP_ROW } from "../../generated/key-help";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../atomic/dialog";
import { Kbd } from "../atomic/kbd";

export interface KeyHelpLabels {
  /** The dialog's title, and the label of the leaf that opens it. Default `"Keybinds"`. */
  title?: string;
}

export interface KeyHelpProps {
  rows: readonly HelpRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels?: KeyHelpLabels;
}

/** Every bound key sequence and what it does. */
export function KeyHelp({ rows, open, onOpenChange, labels = {} }: KeyHelpProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{labels.title ?? KEY_HELP_LABELS.title}</DialogTitle>
        </DialogHeader>
        <ul data-slot="key-help" className={KEY_HELP_LIST}>
          {rows.map(row => (
            <li key={row.sequence} data-slot="key-help-row" className={KEY_HELP_ROW}>
              <span className={KEY_HELP_LABEL}>{row.label}</span>
              <Kbd>{row.sequence}</Kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
