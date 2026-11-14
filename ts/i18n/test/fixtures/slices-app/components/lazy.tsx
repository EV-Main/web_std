import { useT } from "@evinvest/i18n/react";
import { scope } from "@evinvest/i18n";

const lazy = scope("lazy");

export default function Lazy() {
  const t = useT();
  return <i>{t(lazy.k, "Lazy")}</i>;
}
