import type { Translate } from "@evinvest/i18n";
import type { TipKey } from "./catalog";

export const TIP_COPY = {
  "wallet.x": t => ({ title: t("Wallet tip"), body: t("Wallet tip body") }),
  "invest.y": t => ({ title: t.ctx("tips", "Invest tip"), body: t("Invest tip body") }),
} satisfies Record<TipKey, (t: Translate) => { title: string; body: string }>;

export const tipsHeading = (t: Translate) => t("Tips");
