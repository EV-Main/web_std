import { scope } from "@evinvest/i18n";
const orphan = scope("orphan");

// Under the root but imported by nothing.
declare const t: (key: string, en: string) => string;
t(orphan.k, "Orphan");
