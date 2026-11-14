// No directive: a plain module, client only because a client file imports it.
import type { Translate } from "@evinvest/i18n";
import { scope } from "@evinvest/i18n";

const helperKeys = scope("helper");

export const helper = (t: Translate) => t(helperKeys.k, "Helper");
