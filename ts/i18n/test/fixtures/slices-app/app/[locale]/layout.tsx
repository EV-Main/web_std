import type { ReactNode } from "react";
import { translator } from "@evinvest/i18n";
import { Nav } from "@/shell/nav";
import "@/styles/globals.css";

// Server: its title renders into <head>, never on the client.
export async function generateMetadata() {
  const t = translator({}, "en");
  return { title: t("EV") };
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
