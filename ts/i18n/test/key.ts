import { scope, type Key } from "../src/index";

/** A dotted path from the shared fixtures, as the Key a call site would write. */
export const keyAt = (path: string): Key => {
  const [root, ...rest] = path.split(".");
  return rest.reduce<Key>((key, segment) => key[segment], scope(root as string));
};
