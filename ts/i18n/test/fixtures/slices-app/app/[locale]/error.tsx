"use client";
import { useT } from "@evinvest/i18n/react";
import { scope } from "@evinvest/i18n";

const err = scope("err");

export default function ErrorBoundary() {
  const t = useT();
  return <p>{t(err.title, "Something went wrong")}</p>;
}
