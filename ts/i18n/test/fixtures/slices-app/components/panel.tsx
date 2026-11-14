"use client";
import { useT } from "@evinvest/i18n/react";
import { helper } from "./helper.js";

const Lazy = () => import("./lazy");

export function Panel() {
  const t = useT();
  void Lazy;
  return (
    <div>
      {t("Panel")}
      {helper(t)}
    </div>
  );
}
