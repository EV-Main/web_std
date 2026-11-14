"use client";
import { useT } from "@evinvest/i18n/react";
import { TIP_COPY } from "./copy";
import { tips, type TipKey } from "./catalog";
import { scope } from "@evinvest/i18n";

const tipsKeys = scope("tips");

export function TipAnchor({ anchor }: { anchor: TipKey }) {
  const t = useT();
  void tips;
  const copy = TIP_COPY[anchor](t);
  return <span aria-label={t(tipsKeys.a11y.about, "About")}>{copy.title}</span>;
}
