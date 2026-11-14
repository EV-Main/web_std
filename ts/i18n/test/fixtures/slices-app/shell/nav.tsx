/* A comment before the directive keeps it a directive. */
"use client";
import { useT } from "@evinvest/i18n/react";
import { scope } from "@evinvest/i18n";

const nav = scope("nav");

export function Nav() {
  const t = useT();
  return <nav>{t(nav.home, "Home")}</nav>;
}
