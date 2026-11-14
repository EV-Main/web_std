/**
 * `evinvest-i18n-rekey` — the 0.14 codemod: `t("hero.title", en)` becomes
 * `t(hero.title, en)`, with one `const hero = scope("hero")` per root a file uses.
 * Keys keep their strings, so catalogues need no change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { DEFAULT_EXCLUDE, InputError, list, parse, parseFlags, sourceFiles, where } from "./calls.js";

const SEGMENT = /^[A-Za-z_$][\w$]*$/;

const reserved = (name: string): boolean =>
  ts.identifierToKeywordKind(ts.factory.createIdentifier(name)) !== undefined;

/** Whether an identifier can name a binding a scope const would clash with. */
const binds = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)) && parent.name === node)
    return false;
  const intrinsic = (ts.isJsxOpeningElement(parent) || ts.isJsxClosingElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
    /^[a-z]/.test(node.text);
  return !intrinsic;
};

/** The rewritten text of one file, `null` when it has no literal-keyed `t()`, plus what it refused. */
export function rekey(path: string, text: string): { text: string | null; errors: string[] } {
  const source = parse(path, text);
  const taken = new Set<string>();
  const calls: { start: number; end: number; segments: string[] }[] = [];
  const errors: string[] = [];
  let importsScope = false;

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && binds(node)) taken.add(node.text);
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@evinvest/i18n" &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(e => e.name.text === "scope" && e.propertyName === undefined)
    )
      importsScope = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const [key] = node.arguments;
      if (key !== undefined && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
        const segments = key.text.split(".");
        if (segments.every(s => SEGMENT.test(s)))
          calls.push({ start: key.getStart(source), end: key.getEnd(), segments });
        else errors.push(`${where(path, source, node)}: "${key.text}" has a segment that is not an identifier`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (calls.length === 0) return { text: null, errors };

  const names = new Map<string, string>();
  for (const { segments } of calls) {
    const root = segments[0] as string;
    if (names.has(root)) continue;
    let name = root;
    while (taken.has(name) || reserved(name)) name = `${name}Keys`;
    taken.add(name);
    names.set(root, name);
  }

  let out = text;
  for (const { start, end, segments } of [...calls].sort((a, b) => b.start - a.start)) {
    const [root, ...rest] = segments;
    out = out.slice(0, start) + [names.get(root as string), ...rest].join(".") + out.slice(end);
  }

  // After the last import, else after the directive prologue ("use client" stays first).
  const statements = source.statements;
  const lastImport = [...statements].reverse().find(ts.isImportDeclaration);
  const directive = (s: ts.Statement) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression);
  const prologueEnd = statements.findIndex(s => !directive(s));
  const anchor = lastImport ?? statements[(prologueEnd === -1 ? statements.length : prologueEnd) - 1];
  const at = anchor === undefined ? 0 : anchor.getEnd();
  const consts = [...names]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([root, name]) => `const ${name} = scope("${root}");`)
    .join("\n");
  const importLine = importsScope ? "" : 'import { scope } from "@evinvest/i18n";';
  const block =
    anchor === undefined
      ? `${importLine === "" ? "" : `${importLine}\n`}${consts}\n\n`
      : `${importLine === "" ? "" : `\n${importLine}`}\n\n${consts}`;
  // Edits before `at` already happened above, but every key literal sits after the imports.
  return { text: out.slice(0, at) + block + out.slice(at), errors };
}

const USAGE = `Usage: evinvest-i18n-rekey [--root <dir>] [--exclude <a,b>]

Rewrite every t("a.b.c", en) under --root to t(a.b.c, en), declaring one
const a = scope("a") per root a file uses. Keys keep their strings.

  --root <dir>       the app (default: the working directory)
  --exclude <a,b>    directory and file names that are not source, at any depth
  -h, --help         print this and exit`;

export function runRekey(argv: readonly string[]): void {
  const flags = parseFlags(argv, ["root", "exclude"]);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const root = flags.value("root") ?? process.cwd();
  const skip = new Set([...DEFAULT_EXCLUDE, ...list(flags.value("exclude"))]);
  const errors: string[] = [];
  let changed = 0;
  for (const path of sourceFiles(root, skip, "")) {
    const result = rekey(path, readFileSync(join(root, path), "utf8"));
    errors.push(...result.errors);
    if (result.text === null) continue;
    writeFileSync(join(root, path), result.text);
    changed += 1;
  }
  console.log(`${changed} file${changed === 1 ? "" : "s"} rekeyed`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`  ${error}`);
    throw new InputError(`${errors.length} call site${errors.length === 1 ? "" : "s"} left for a hand rewrite`);
  }
}
