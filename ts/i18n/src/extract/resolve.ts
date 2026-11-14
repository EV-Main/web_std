/**
 * Module resolution for the extractors, as `moduleResolution: bundler` does it:
 * relative paths, tsconfig `paths` and `baseUrl`. Syntactic, no program.
 */
import { statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

import { InputError } from "./calls.js";

/** Parsed and followed; anything else that resolves (CSS, JSON, SVG) is a leaf. */
export const CODE = /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/;

/** Tried in this order after the bare path, as `moduleResolution: bundler` does. */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
/** A `./x.js` specifier in TypeScript source names `./x.ts`. */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export interface Paths {
  /** Absolute directory `paths` targets are relative to. */
  base: string;
  /** `[prefix, suffix, targets]`, longest prefix first, as tsc tries them. */
  patterns: { prefix: string; suffix: string; wildcard: boolean; targets: string[] }[];
  /** Absolute `baseUrl`, which also resolves bare specifiers. */
  baseUrl: string | null;
}

export type Resolution =
  | { kind: "local"; path: string }
  | { kind: "external" }
  | { kind: "unresolved"; alias?: string };

/**
 * Whether a bare specifier can name an npm package. `@/x` (an empty scope),
 * `~/x` and `#x` cannot: they only mean something through an alias — tsconfig
 * `paths`, a bundler alias, package.json `imports` — so one nothing here maps
 * is a local import the graph lost, not a package to stop at.
 */
const couldBePackage = (specifier: string): boolean =>
  specifier.startsWith("@") ? /^@[^/]+\/[^/]/.test(specifier) : !/^[~#]/.test(specifier);

export const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** `paths` and `baseUrl` of one tsconfig, `extends` followed. */
export function readPaths(tsconfig: string): Paths {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error !== undefined)
    throw new InputError(`${tsconfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  // Only the options are wanted: listing the project's files would walk the tree for nothing.
  const host: ts.ParseConfigHost = { ...ts.sys, readDirectory: () => [] };
  const { options } = ts.parseJsonConfigFileContent(read.config, host, dirname(tsconfig), undefined, tsconfig);
  // tsc records where an inherited `paths` was declared, which is what its targets are relative to.
  const declaredAt = options["pathsBasePath"];
  const base = options.baseUrl ?? (typeof declaredAt === "string" ? declaredAt : dirname(tsconfig));
  const patterns = Object.entries(options.paths ?? {})
    .map(([pattern, targets]) => {
      const star = pattern.indexOf("*");
      return star === -1
        ? { prefix: pattern, suffix: "", wildcard: false, targets }
        : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), wildcard: true, targets };
    })
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return { base, patterns, baseUrl: options.baseUrl ?? null };
}

/** Resolves `specifier` as imported from the root-relative file `from`. */
export type Resolve = (from: string, specifier: string) => Resolution;

export function createResolver(root: string, paths: Paths | null): Resolve {
  const toRoot = (abs: string) => relative(root, abs).split(sep).join("/");

  const find = (abs: string): string | null => {
    const ext = extname(abs);
    const swapped = (JS_TO_TS[ext] ?? []).map(to => abs.slice(0, -ext.length) + to);
    const candidates = [
      ...swapped,
      abs,
      ...EXTENSIONS.map(e => abs + e),
      ...EXTENSIONS.map(e => join(abs, `index${e}`)),
    ];
    const hit = candidates.find(isFile);
    return hit === undefined ? null : toRoot(hit);
  };

  return (from: string, raw: string): Resolution => {
    // A bundler query (`./icon.svg?url`) names the file before it. A leading `#`
    // is a subpath import (`#components/b`), not a fragment, so it stays.
    const specifier = raw.replace(/(?!^)[?#].*$/, "");
    const local = (abs: string): Resolution => {
      const path = find(abs);
      return path === null ? { kind: "unresolved" } : { kind: "local", path };
    };
    if (/^\.\.?(\/|$)/.test(specifier)) return local(resolve(root, dirname(from), specifier));
    if (specifier.startsWith("/")) return local(specifier);
    if (paths !== null) {
      for (const { prefix, suffix, wildcard, targets } of paths.patterns) {
        const matches = wildcard
          ? specifier.length >= prefix.length + suffix.length &&
            specifier.startsWith(prefix) &&
            specifier.endsWith(suffix)
          : specifier === prefix;
        if (!matches) continue;
        const capture = wildcard ? specifier.slice(prefix.length, specifier.length - suffix.length) : "";
        for (const target of targets) {
          const path = find(resolve(paths.base, target.replace("*", capture)));
          if (path !== null) return { kind: "local", path };
        }
        // A bare `*` maps everything, packages included; anything narrower
        // (`@/*`) is a promise that the specifier is ours, so a miss is a broken import.
        if (prefix !== "" || suffix !== "")
          return { kind: "unresolved" };
      }
      if (paths.baseUrl !== null) {
        const path = find(resolve(paths.baseUrl, specifier));
        if (path !== null) return { kind: "local", path };
      }
    }
    if (!couldBePackage(specifier))
      return {
        kind: "unresolved",
        alias:
          paths === null
            ? "it is an alias, not a package, and no tsconfig was read to map it"
            : "it is an alias, not a package, and the tsconfig's paths do not map it",
      };
    return { kind: "external" };
  };
}

