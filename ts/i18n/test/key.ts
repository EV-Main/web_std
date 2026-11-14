import { scope, type Key } from "../src/index";

/** A dotted path from the shared fixtures, as the Key a call site would write. */
export const keyAt = (path: string): Key => {
  const [root, ...rest] = path.split(".");
  return rest.reduce((key, segment) => key[segment] as Key, scope(root as string));
};
