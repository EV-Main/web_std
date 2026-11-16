/**
 * A service's views by its table: ev_lib's `views` writes it (the document's `x-views`, generated
 * into the service as `VIEWS`), and `href`/`parse` read it with the same codec the Rust does
 * (`tests/fixtures/views/` holds both to it).
 */

/** A value's schema, in the one form ev_lib writes: a nullable one's `type` is `[base, "null"]`. */
export interface Schema {
  readonly type: string | readonly [string, "null"];
  readonly enum?: readonly (string | null)[];
  readonly items?: Schema;
  readonly prefixItems?: readonly Schema[];
  readonly description?: string;
}

export interface ObjectSchema {
  readonly type: "object";
  readonly properties: { readonly [key: string]: Schema };
  readonly required: readonly string[];
}

export interface Entry {
  readonly path: string;
  readonly description: string;
  readonly params: ObjectSchema;
  readonly query: ObjectSchema;
  readonly needs?: string;
  readonly key?: string;
  /** The service whose views go under this one: everything below it is `below`'s. */
  readonly nest?: string;
  /** The key that opens the nested service's own keys. */
  readonly scope?: string;
}

export interface Table {
  /** The query keys beside every view, which the page keeps across its moves. */
  readonly carried: ObjectSchema;
  readonly views: { readonly [name: string]: Entry };
}

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Base<S> = S extends { readonly type: readonly [infer B, "null"] } ? B : S extends { readonly type: infer B } ? B : never;
type Words<S> = S extends { readonly enum: readonly (infer W)[] } ? Exclude<W, null> : never;
type Json<S> = S extends { readonly properties: unknown; readonly required: readonly unknown[] }
  ? Fields<S>
  : S extends { readonly additionalProperties: infer A }
    ? { [key: string]: Value<A> }
    : unknown;

/** What a value of schema `S` is in TS: an integer is a `number`. */
export type Value<S> = [Words<S>] extends [never]
  ? Base<S> extends "string"
    ? string
    : Base<S> extends "integer" | "number"
      ? number
      : Base<S> extends "boolean"
        ? boolean
        : Base<S> extends "array"
          ? S extends { readonly prefixItems: infer P extends readonly unknown[] }
            ? { -readonly [K in keyof P]: Value<P[K]> }
            : S extends { readonly items: infer I }
              ? Value<I>[]
              : never
          : Base<S> extends "object"
            ? Json<S>
            : never
  : Words<S>;

/** An object schema's fields: what may be absent is optional. */
export type Fields<O> = O extends { readonly properties: infer P; readonly required: readonly (infer R)[] }
  ? Simplify<{ -readonly [K in keyof P & R]: Value<P[K]> } & { -readonly [K in Exclude<keyof P, R>]?: Value<P[K]> }>
  : never;

/** A view by name and its params (path and query alike), as an agent's `open` names one. */
export type At<T extends Table> = {
  [N in keyof T["views"] & string]: { view: N; params: Simplify<Fields<T["views"][N]["params"]> & Fields<T["views"][N]["query"]>> };
}[keyof T["views"] & string];

export type Carried<T extends Table> = Fields<T["carried"]>;

/** An href that is no view, or a view's params that do not fit it. */
export class ViewError extends Error {
  override name = "ViewError";
}

type Scalar = { kind: "text"; words: readonly string[] | null } | { kind: "int" } | { kind: "num" };
type Form = Scalar | { kind: "flag" } | { kind: "list"; item: Scalar } | { kind: "tuple"; items: readonly Scalar[] } | { kind: "json" };
interface Shape {
  form: Form;
  nullable: boolean;
}

function shape(s: Schema): Shape {
  const [base, nullable] = typeof s.type === "string" ? [s.type, false] : [s.type[0], true];
  const scalar = (base: string, s: Schema): Scalar => {
    if (base === "string") return { kind: "text", words: s.enum === undefined ? null : s.enum.filter((w): w is string => w !== null) };
    if (base === "integer") return { kind: "int" };
    if (base === "number") return { kind: "num" };
    throw new ViewError(`a ${base} has no URL form`);
  };
  const item = (s: Schema): Scalar => {
    if (typeof s.type !== "string") throw new ViewError("a list's or a tuple's items are strings, numbers or words");
    return scalar(s.type, s);
  };
  if (base === "boolean") return { form: { kind: "flag" }, nullable };
  if (base === "array") {
    if (s.prefixItems !== undefined) return { form: { kind: "tuple", items: s.prefixItems.map(item) }, nullable };
    if (s.items !== undefined) return { form: { kind: "list", item: item(s.items) }, nullable };
    throw new ViewError("an array has items");
  }
  if (base === "object") return { form: { kind: "json" }, nullable };
  return { form: scalar(base, s), nullable };
}

/** `undefined` when it must be there. */
function absent({ form, nullable }: Shape): unknown {
  if (nullable) return null;
  if (form.kind === "flag") return false;
  if (form.kind === "list") return [];
  return undefined;
}

function text(s: Scalar, v: unknown): string {
  if (s.kind === "text" && typeof v === "string") {
    if (s.words !== null && !s.words.includes(v)) throw new ViewError(`${JSON.stringify(v)} is none of ${s.words.join(", ")}`);
    return v;
  }
  if (s.kind === "int" && Number.isSafeInteger(v)) return String(v);
  if (s.kind === "num" && typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new ViewError(`${JSON.stringify(v)} is no ${s.kind}`);
}

function joined(items: readonly (readonly [Scalar, unknown])[]): string {
  const texts = items.map(([s, v]) => text(s, v));
  const comma = texts.find((t) => t.includes(","));
  if (comma !== undefined) throw new ViewError(`${JSON.stringify(comma)}: an item of a list has no comma`);
  return texts.join(",");
}

/** Object keys sorted, as the Rust writes JSON. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
  return v;
}

/** `undefined`: absent from the URL. */
function encode(sh: Shape, v: unknown): string | undefined {
  if (v === null || v === undefined) {
    if (sh.nullable) return undefined;
    throw new ViewError("null is no value of it");
  }
  const { form } = sh;
  switch (form.kind) {
    case "flag":
      if (typeof v !== "boolean") throw new ViewError(`${JSON.stringify(v)} is no flag`);
      return v ? "" : undefined;
    case "list":
      if (!Array.isArray(v)) throw new ViewError(`${JSON.stringify(v)} is no list`);
      return v.length === 0 && !sh.nullable ? undefined : joined(v.map((i) => [form.item, i] as const));
    case "tuple":
      if (!Array.isArray(v) || v.length !== form.items.length) throw new ViewError(`${JSON.stringify(v)} is no ${form.items.length}-tuple`);
      return joined(form.items.map((s, i) => [s, v[i]] as const));
    case "json":
      return JSON.stringify(sorted(v));
    default:
      return text(form, v);
  }
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

function value(s: Scalar, t: string): unknown {
  switch (s.kind) {
    case "text":
      if (s.words !== null && !s.words.includes(t)) throw new ViewError(`${JSON.stringify(t)} is none of ${s.words.join(", ")}`);
      return t;
    case "int": {
      const n = Number(t);
      if (!INTEGER.test(t) || !Number.isSafeInteger(n)) throw new ViewError(`${JSON.stringify(t)} is no safe integer`);
      return n;
    }
    case "num": {
      const n = Number(t);
      if (!NUMBER.test(t) || !Number.isFinite(n)) throw new ViewError(`${JSON.stringify(t)} is no finite number`);
      return n;
    }
  }
}

function decode({ form, nullable }: Shape, t: string): unknown {
  switch (form.kind) {
    case "flag":
      if (t !== "") throw new ViewError(`${JSON.stringify(t)}: a flag is there with no value`);
      return true;
    case "list":
      if (t === "") {
        if (nullable) return [];
        throw new ViewError("an empty list is no key at all");
      }
      return t.split(",").map((i) => value(form.item, i));
    case "tuple": {
      const items = t.split(",");
      if (items.length !== form.items.length) throw new ViewError(`${JSON.stringify(t)} is no ${form.items.length}-tuple`);
      return form.items.map((s, i) => value(s, items[i]!));
    }
    case "json":
      try {
        return JSON.parse(t);
      } catch (e) {
        throw new ViewError(`${JSON.stringify(t)}: ${String(e)}`);
      }
    default:
      return value(form, t);
  }
}

type Seg = { param: string } | { fixed: string };

function segments(path: string): Seg[] {
  if (path === "" || path === "/") return [];
  return path
    .slice(1)
    .split("/")
    .map((s) => (s.startsWith("{") && s.endsWith("}") ? { param: s.slice(1, -1) } : { fixed: s }));
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `at`'s href, `carried` beside it. Its query is sorted by key. */
export function href<T extends Table>(table: T, at: At<T>, carried?: Carried<T>): string {
  const view: string = at.view;
  const params = at.params as Record<string, unknown>;
  const fail = (why: string) => new ViewError(`${view}: ${why}`);
  const entry = has(table.views, view) ? table.views[view] : undefined;
  if (entry === undefined) throw new ViewError(`no view is named ${JSON.stringify(view)}`);
  const ps = entry.params.properties;
  const qs = entry.query.properties;
  const unknown = Object.keys(params).find((k) => !has(ps, k) && !has(qs, k));
  if (unknown !== undefined) throw fail(`it has no param ${unknown}`);
  let out = "";
  for (const seg of segments(entry.path)) {
    if ("fixed" in seg) out += `/${seg.fixed}`;
    else {
      if (!has(params, seg.param)) throw fail(`${seg.param} is missing`);
      out += `/${encodeURIComponent(encode(shape(ps[seg.param]!), params[seg.param])!)}`;
    }
  }
  const pairs = new Map<string, string>();
  for (const [k, s] of Object.entries(qs)) {
    const sh = shape(s);
    if (has(params, k)) {
      const t = encode(sh, params[k]);
      if (t !== undefined) pairs.set(k, t);
    } else if (absent(sh) === undefined) throw fail(`${k} is missing`);
  }
  for (const [k, v] of Object.entries((carried ?? {}) as Record<string, unknown>)) {
    const s = table.carried.properties[k];
    if (s === undefined) throw fail(`${k} is carried by no view`);
    const t = encode(shape(s), v);
    if (t !== undefined) pairs.set(k, t);
  }
  if (entry.nest !== undefined) {
    const below = params["below"];
    if (typeof below !== "string") throw fail("below is a string, the href under it");
    const cut = below.indexOf("?");
    const [path, query] = cut === -1 ? [below, ""] : [below.slice(0, cut), below.slice(cut + 1)];
    if (path !== "" && !path.startsWith("/")) throw fail(`below ${JSON.stringify(below)} starts with / or ?`);
    out += path;
    for (const [k, v] of new URLSearchParams(query)) {
      if (pairs.has(k)) throw fail(`below's ?${k} is a key of this table's`);
      pairs.set(k, v);
    }
  }
  if (out === "") out = "/";
  const query = new URLSearchParams([...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();
  return query === "" ? out : `${out}?${query}`;
}

/** The view `href` is, and the carried keys beside it. An absent key is absent from the params. */
export function parse<T extends Table>(table: T, href: string): { at: At<T>; carried: Carried<T> } {
  const fail = (why: string) => new ViewError(`${href}: ${why}`);
  if (href.includes("#")) throw fail("a view has no fragment");
  const cut = href.indexOf("?");
  const [path, query] = cut === -1 ? [href, ""] : [href.slice(0, cut), href.slice(cut + 1)];
  if (!path.startsWith("/")) throw fail("an href starts with /");
  let rest = path.slice(1);
  if (rest.length > 1 && rest.endsWith("/")) rest = rest.slice(0, -1); // a static export serves `/sites/` for `/sites`
  const raw = rest === "" ? [] : rest.split("/");
  if (raw.some((s) => s === "")) throw fail("an empty segment");
  let decoded: string[];
  try {
    decoded = raw.map(decodeURIComponent);
  } catch (e) {
    throw fail(String(e));
  }

  let best: { rank: number[]; name: string; entry: Entry } | undefined;
  for (const [name, entry] of Object.entries(table.views)) {
    const t = segments(entry.path);
    const marker = entry.nest !== undefined;
    if (marker ? decoded.length < t.length : decoded.length !== t.length) continue;
    if (t.some((s, i) => "fixed" in s && s.fixed !== decoded[i])) continue;
    // Position by position: a static segment beats a param, a param a nest's rest.
    const rank = decoded.map((_, i) => {
      const s = t[i];
      return s === undefined ? 2 : "fixed" in s ? 0 : 1;
    });
    rank.push(marker ? 2 : 0);
    if (best === undefined || less(rank, best.rank)) best = { rank, name, entry };
  }
  if (best === undefined) throw fail("no view has this path");
  const { name, entry } = best;
  const inView = (why: string) => new ViewError(`${href}: ${name}: ${why}`);
  const at = (e: unknown, k: string) => inView(`${k}: ${e instanceof ViewError ? e.message : String(e)}`);

  const params: Record<string, unknown> = {};
  const t = segments(entry.path);
  t.forEach((s, i) => {
    if ("param" in s)
      try {
        params[s.param] = decode(shape(entry.params.properties[s.param]!), decoded[i]!);
      } catch (e) {
        throw at(e, s.param);
      }
  });
  const carried: Record<string, unknown> = {};
  const passed: [string, string][] = [];
  const seen = new Set<string>();
  for (const [k, v] of new URLSearchParams(query)) {
    if (seen.has(k)) throw inView(`?${k} is given twice`);
    seen.add(k);
    const own = has(entry.query.properties, k) ? entry.query.properties[k] : undefined;
    const kept = has(table.carried.properties, k) ? table.carried.properties[k] : undefined;
    try {
      if (own !== undefined) params[k] = decode(shape(own), v);
      else if (kept !== undefined) carried[k] = decode(shape(kept), v);
      else if (entry.nest !== undefined) passed.push([k, v]);
      else throw inView(`?${k} is no key of it`);
    } catch (e) {
      if (e instanceof ViewError && e.message.startsWith(href)) throw e;
      throw at(e, k);
    }
  }
  for (const [k, s] of Object.entries(entry.query.properties)) if (!has(params, k) && absent(shape(s)) === undefined) throw inView(`?${k} is missing`);
  if (entry.nest !== undefined) {
    const query = new URLSearchParams(passed).toString();
    params["below"] = raw.slice(t.length).map((s) => `/${s}`).join("") + (query === "" ? "" : `?${query}`);
  }
  return { at: { view: name, params } as At<T>, carried: carried as Carried<T> };
}

function less(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return a.length < b.length;
}
