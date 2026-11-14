"use client";
import { useT } from "@evinvest/i18n/react";

export default function ErrorBoundary() {
  const t = useT();
  return <p>{t("Something went wrong")}</p>;
}
