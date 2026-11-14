/**
 * Message keys as values. `scope("gmbs")` is a root; property access nests, so
 * `gmbs.add.hint` is the key `gmbs.add.hint`. A key has no string form: the only
 * way to one is a member chain from a `scope("<literal>")`, which is what lets
 * `evinvest-i18n-extract` read every key statically.
 */

/**
 * A message key: a scope root or any member chain below one. Members are `any`: under
 * `noUncheckedIndexedAccess` an index signature of `Key` reads as `Key | undefined`.
 * That a key is a member chain off a scope is the extractor's check, not the type's.
 */
export interface Key {
  readonly "@evinvest/i18n/key": true; // a string brand: react.d.ts and index.d.cts each declare Key again
  readonly [segment: string]: any;
}

const PATH = Symbol("@evinvest/i18n key path");

function node(path: string): Key {
  const children = new Map<string, Key>();
  return new Proxy(Object.freeze({}) as Key, {
    get(_, prop) {
      if (prop === PATH) return path;
      // Symbols (toPrimitive, iterator, inspect) are not segments; unanswered, `${key}` throws.
      if (typeof prop === "symbol") return undefined;
      let child = children.get(prop);
      if (child === undefined) {
        child = node(`${path}.${prop}`);
        children.set(prop, child);
      }
      return child;
    },
    set() {
      throw new TypeError(`@evinvest/i18n: key ${path} is read-only`);
    },
  });
}

const SEGMENT = /^[A-Za-z_$][\w$]*$/;

/**
 * A root key. The name is a literal identifier: the extractor reads it off the call.
 *
 * @example
 * ```ts
 * export const gmbs = scope("gmbs");
 * t(gmbs.add.hint, "Paste a Google Maps link");   // key gmbs.add.hint
 * ```
 */
export function scope(name: string): Key {
  if (!SEGMENT.test(name)) throw new TypeError(`@evinvest/i18n: scope name "${name}" is not an identifier`);
  return node(name);
}

/** The dotted path of a key. Package-internal: a key has no public string form. */
export function pathOf(key: Key): string {
  const path = (key as unknown as Record<symbol, unknown>)[PATH];
  if (typeof path !== "string") throw new TypeError("@evinvest/i18n: t() takes a Key from scope(), not a string");
  return path;
}
