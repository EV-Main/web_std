"use client";
import { useT } from "@evinvest/i18n/react";
import { scope } from "@evinvest/i18n";

const typeonly = scope("typeonly");

export type Only = string;

export function TypeOnly() {
  const t = useT();
  return t(typeonly.k, "Type only");
}
