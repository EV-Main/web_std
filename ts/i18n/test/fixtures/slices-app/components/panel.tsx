"use client";
import { useT } from "@evinvest/i18n/react";
import { helper } from "./helper.js";
import { scope } from "@evinvest/i18n";

const panel = scope("panel");

const Lazy = () => import("./lazy");

export function Panel() {
  const t = useT();
  void Lazy;
  return (
    <div>
      {t(panel.k, "Panel")}
      {helper(t)}
    </div>
  );
}
