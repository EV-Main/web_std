/**
 * Reading `t(key, en)` call sites out of a source tree — shared by the
 * catalogue extractor and the slice generator, so both refuse exactly the same
 * call sites.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { CODE, type Resolve } from "./resolve.js";

/** One readable `t()` call site. */
export interface Entry {
  key: string;
  /** The English as written at the call site. */
  en: string;
  /** `path/to/file.tsx:12` — where it was read from. */
  where: string;
}

/** What {@link collect} reads, and what it refuses to guess at. */
export interface Extraction {
  entries: Entry[];
  errors: string[];
}

/** Skipped by every app: package manager and tool output nothing authors. */
export const DEFAULT_EXCLUDE: readonly string[] = ["node_modules", "dist", "build", ".next"];

/** `.ts`, `.tsx`, `.mts`, `.mtsx` — a build script renders copy as readily as a component. */
export const SOURCE = /\.m?tsx?$/;

export function* sourceFiles(
  root: string,
  exclude: ReadonlySet<string>,
  dir: string,
): Generator<string> {
  for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (item.name.startsWith(".") || exclude.has(item.name)) continue;
    const path = dir === "" ? item.name : `${dir}/${item.name}`;
    if (item.isDirectory()) yield* sourceFiles(root, exclude, path);
    else if (SOURCE.test(item.name)) yield path;
  }
}

/** TSX for every file: a `.ts` file parses the same, and JSX in it is then not an error. */
export const parse = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** `path:line` of a node, for an error or an entry. */
export const where = (path: string, source: ts.SourceFile, node: ts.Node): string =>
  `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

/** A string literal or a backtick string with no `${}` in it. */
export function literal(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** What a key expression evaluates to, statically. `null`: no such binding here. */
type Value = { key: string } | { module: string } | { refused: string } | null;

const SEGMENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Reads the key argument of a `t()` back to the `scope("<literal>")` it hangs off:
 * through property access, `const` bindings in any enclosing block, and imports
 * (named, namespace, re-exported, `export *`) resolved by `resolve`.
 */
export interface Keys {
  /** The parsed file at a root-relative path; cached. */
  readonly source: (path: string) => ts.SourceFile;
  /** The dotted key `node` evaluates to, or why it cannot be read. */
  readonly keyOf: (path: string, node: ts.Expression) => { key: string } | { refused: string };
}

export function createKeys(root: string, resolve: Resolve): Keys {
  const files = new Map<string, ts.SourceFile>();
  const source = (path: string): ts.SourceFile => {
    let file = files.get(path);
    if (file === undefined) {
      file = parse(path, readFileSync(join(root, path), "utf8"));
      files.set(path, file);
    }
    return file;
  };
  const refused = (why: string): Value => ({ refused: why });

  const expression = (path: string, raw: ts.Expression, seen: ReadonlySet<string>): Value => {
    let node = raw;
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
      node = node.expression;
    if (ts.isPropertyAccessExpression(node)) {
      if (node.questionDotToken !== undefined) return refused("uses ?. — a key is never absent");
      const base = expression(path, node.expression, seen);
      if (base === null || "refused" in base) return base;
      if ("module" in base) return exported(base.module, node.name.text, seen) ?? refused(`${base.module} does not export ${node.name.text}`);
      return { key: `${base.key}.${node.name.text}` };
    }
    if (ts.isElementAccessExpression(node)) return refused("uses computed access; a key is a member chain — use a closed table");
    if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const name = arg === undefined ? null : literal(arg);
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "scope") return refused("is a call other than scope()");
      if (node.arguments.length !== 1 || name === null || !SEGMENT.test(name))
        return refused("calls scope() without one literal identifier");
      return { key: name };
    }
    if (ts.isIdentifier(node)) return binding(path, node, seen);
    if (literal(node) !== null) return refused(`is a string; a key is a member chain off scope("…")`);
    return refused(`is a ${ts.SyntaxKind[node.kind]}, not a key`);
  };

  const declares = (name: ts.BindingName, text: string): boolean =>
    ts.isIdentifier(name) ? name.text === text : name.elements.some(e => !ts.isOmittedExpression(e) && declares(e.name, text));

  const fromList = (path: string, list: ts.VariableDeclarationList, text: string, seen: ReadonlySet<string>): Value => {
    const declaration = list.declarations.find(d => declares(d.name, text));
    if (declaration === undefined) return null;
    if ((list.flags & ts.NodeFlags.Const) === 0) return refused(`reads ${text}, which is not a const`);
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
      return refused(`reads ${text}, which is destructured`);
    return expression(path, declaration.initializer, seen);
  };

  /** A name declared directly among `statements`, imports included at the top level. */
  const among = (path: string, statements: readonly ts.Statement[], text: string, seen: ReadonlySet<string>): Value => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        const found = fromList(path, statement.declarationList, text, seen);
        if (found !== null) return found;
      } else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
        statement.name?.text === text
      ) {
        return refused(`reads ${text}, which is not a const`);
      } else if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause === undefined || clause.isTypeOnly) continue;
        if (clause.name?.text === text) return refused(`reads ${text}, a default import`);
        const bindings = clause.namedBindings;
        if (bindings === undefined) continue;
        const target = () => module(path, statement.moduleSpecifier);
        if (ts.isNamespaceImport(bindings)) {
          if (bindings.name.text !== text) continue;
          const at = target();
          return "refused" in at ? at : { module: at.path };
        }
        const element = bindings.elements.find(e => e.name.text === text);
        if (element === undefined) continue;
        const at = target();
        if ("refused" in at) return at;
        const name = (element.propertyName ?? element.name).text;
        return exported(at.path, name, seen) ?? refused(`imports ${name}, which ${at.path} does not export`);
      }
    }
    return null;
  };

  const module = (path: string, specifier: ts.Expression): { path: string } | { refused: string } => {
    const text = literal(specifier);
    if (text === null) return { refused: "is imported from a computed path" };
    const resolution = resolve(path, text);
    if (resolution.kind === "local") return { path: resolution.path };
    return { refused: `is imported from "${text}", which is ${resolution.kind === "external" ? "a package" : "unresolved"}` };
  };

  const binding = (path: string, id: ts.Identifier, seen: ReadonlySet<string>): Value => {
    const text = id.text;
    for (let at: ts.Node | undefined = id.parent; at !== undefined; at = at.parent) {
      if (ts.isFunctionLike(at) && at.parameters.some(p => declares(p.name, text)))
        return refused(`reads ${text}, a parameter`);
      if ((ts.isForOfStatement(at) || ts.isForInStatement(at) || ts.isForStatement(at)) && at.initializer !== undefined &&
        ts.isVariableDeclarationList(at.initializer) && at.initializer.declarations.some(d => declares(d.name, text)))
        return refused(`reads ${text}, a loop variable`);
      if (ts.isCatchClause(at) && at.variableDeclaration !== undefined && declares(at.variableDeclaration.name, text))
        return refused(`reads ${text}, a caught error`);
      const statements =
        ts.isSourceFile(at) || ts.isBlock(at) || ts.isModuleBlock(at) || ts.isCaseClause(at) || ts.isDefaultClause(at)
          ? at.statements
          : null;
      if (statements === null) continue;
      const found = among(path, statements, text, seen);
      if (found !== null) return found;
    }
    return refused(`reads ${text}, which is not declared in ${path}`);
  };

  /** The value `path` exports as `name`; `null` when it exports no such name. */
  const exported = (path: string, name: string, seen: ReadonlySet<string>): Value => {
    const id = `${path}#${name}`;
    if (seen.has(id)) return refused(`reaches ${id} again — a cycle of re-exports`);
    const next = new Set(seen).add(id);
    if (!CODE.test(path)) return null;
    const file = source(path);
    const stars: ts.Expression[] = [];
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement)) {
        if (!statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const found = fromList(path, statement.declarationList, name, next);
        if (found !== null) return found;
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const clause = statement.exportClause;
        const from = statement.moduleSpecifier;
        if (clause === undefined) {
          if (from !== undefined) stars.push(from);
        } else if (ts.isNamespaceExport(clause)) {
          if (clause.name.text !== name || from === undefined) continue;
          const at = module(path, from);
          return "refused" in at ? at : { module: at.path };
        } else {
          const element = clause.elements.find(e => e.name.text === name);
          if (element === undefined) continue;
          const local = (element.propertyName ?? element.name).text;
          if (from === undefined)
            return among(path, file.statements, local, next) ?? refused(`exports ${local}, which ${path} does not declare`);
          const at = module(path, from);
          if ("refused" in at) return at;
          return exported(at.path, local, next) ?? refused(`re-exports ${local}, which ${at.path} does not export`);
        }
      }
    }
    for (const from of stars) {
      const at = module(path, from);
      if ("refused" in at) continue; // an `export *` of a package re-exports no scope of ours
      const found = exported(at.path, name, next);
      if (found !== null) return found;
    }
    return null;
  };

  return {
    source,
    keyOf: (path, node) => {
      const value = expression(path, node, new Set());
      if (value === null) return { refused: "does not resolve" };
      if ("module" in value) return { refused: "is a module, not a key" };
      return value;
    },
  };
}

/** Every `t(key, en)` in one file, plus the call sites that cannot be read. */
export function callsIn(path: string, keys: Keys): Extraction {
  const source = keys.source(path);
  const entries: Entry[] = [];
  const errors: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const [keyArg, enArg] = node.arguments;
      const at = where(path, source, node);
      const key = keyArg === undefined ? { refused: "is missing" } : keys.keyOf(path, keyArg);
      const en = enArg === undefined ? null : literal(enArg);
      if ("refused" in key) errors.push(`${at}: t() key ${key.refused}`);
      else if (en === null) errors.push(`${at}: t(${key.key}, …) has no literal English second argument`);
      else entries.push({ key: key.key, en, where: at });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { entries, errors };
}

/**
 * One entry per key. Two call sites sharing a key with different English are
 * an error — the catalogue can only hold one of them, so which one ships would
 * be decided by file order.
 */
export function dedupe(entries: readonly Entry[]): Extraction {
  const seen = new Map<string, Entry>();
  const errors: string[] = [];
  for (const entry of entries) {
    const first = seen.get(entry.key);
    if (first === undefined) seen.set(entry.key, entry);
    else if (first.en !== entry.en)
      errors.push(
        `${entry.where}: "${entry.key}" is also defined at ${first.where} with different English\n` +
          `    ${first.where}: ${JSON.stringify(first.en)}\n` +
          `    ${entry.where}: ${JSON.stringify(entry.en)}`,
      );
  }
  return { entries: [...seen.values()], errors };
}

/** The exact bytes a generated JSON file is written as — what a check compares against. */
export const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Input a tool cannot work with — a bad flag, a malformed config, a missing
 * directory. {@link runCli} prints its message alone; anything else is a bug
 * and keeps its stack.
 */
export class InputError extends Error {
  override readonly name = "InputError";
}

/** What {@link parseFlags} read; `help` is set when `-h` / `--help` was among the arguments. */
export interface Flags<V extends string, S extends string> {
  help: boolean;
  value: (name: V) => string | undefined;
  on: (name: S) => boolean;
}

/**
 * The bins' one argument parser: `--name value` or `--name=value` for each of
 * `values`, a bare `--name` for each of `switches`, `-h` / `--help`.
 *
 * Strict on purpose. A tool that writes a committed file must not read a typo
 * (`--ouT`, `--help` misspelt, a forgotten value) as "use the defaults" and then
 * overwrite that file with something else, so anything it does not know is an
 * {@link InputError}, raised before a single file is read.
 */
export function parseFlags<V extends string, S extends string = never>(
  argv: readonly string[],
  values: readonly V[],
  switches: readonly S[] = [],
): Flags<V, S> {
  const isValue = (name: string): name is V => (values as readonly string[]).includes(name);
  const isSwitch = (name: string): name is S => (switches as readonly string[]).includes(name);
  const known = [...values.map(v => `--${v} <value>`), ...switches.map(s => `--${s}`), "--help"];
  const read = new Map<string, string>();
  const set = new Set<string>();
  let help = false;

  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at] ?? "";
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new InputError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (read.has(name) || set.has(name)) throw new InputError(`--${name} given more than once`);
    if (isSwitch(name)) {
      if (eq !== -1) throw new InputError(`--${name} takes no value`);
      set.add(name);
    } else if (isValue(name)) {
      const value = eq === -1 ? argv[++at] : arg.slice(eq + 1);
      if (value === undefined || value === "" || value.startsWith("-"))
        throw new InputError(`--${name} needs a value`);
      read.set(name, value);
    } else {
      throw new InputError(`unknown flag --${name}; known: ${known.join(", ")}`);
    }
  }
  return { help, value: name => read.get(name), on: name => set.has(name) };
}

/**
 * Run a bin's body: an {@link InputError}, or a file the arguments name that
 * does not exist, prints `<bin>: <message>` and exits 2; anything else
 * propagates with its stack.
 */
export function runCli(bin: string, main: () => void): void {
  try {
    main();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const missing = "code" in error && error.code === "ENOENT";
    if (!(error instanceof InputError) && !missing) throw error;
    console.error(`${bin}: ${error.message}`);
    console.error(`Run \`${bin} --help\` for usage.`);
    process.exit(2);
  }
}

/** `a,b,,c` → `["a", "b", "c"]`. */
export const list = (value: string | undefined): string[] =>
  (value ?? "").split(",").filter(s => s !== "");
