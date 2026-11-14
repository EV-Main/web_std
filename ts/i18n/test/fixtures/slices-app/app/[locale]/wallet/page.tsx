import { translator } from "@evinvest/i18n";
import { Panel } from "@/components/panel";
import { TipAnchor } from "../../../tips/anchor";
import type { Only } from "@/components/typeonly";
import { scope } from "@evinvest/i18n";

const wallet = scope("wallet");

export default function WalletPage() {
  const t = translator({}, "en");
  return (
    <main>
      <h1>{t(wallet.server, "Wallet")}</h1>
      <Panel />
      <TipAnchor anchor="wallet.x" />
    </main>
  );
}
