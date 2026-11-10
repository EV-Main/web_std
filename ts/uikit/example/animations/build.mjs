// Builds index.html + kit.css from page.src.html. Class strings are read from the kit's generated tables.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.resolve(HERE, ".."); // the gallery app: its node_modules carry tailwind
const KIT = path.resolve(HERE, "../..");
const require = createRequire(SPEC + "/package.json");
const { compile } = await import(require.resolve("@tailwindcss/node"));
const { Scanner } = await import(require.resolve("@tailwindcss/oxide"));
const postcss = require("postcss");

const gen = (f) => fs.readFileSync(`${KIT}/src/generated/${f}.ts`, "utf8");
const str = (f, name) => {
  const m = gen(f).match(new RegExp(`export const ${name} = "([^"]*)"`));
  if (!m) throw new Error(`${f}:${name}`);
  return m[1];
};
const objv = (f, name, key) => {
  const blk = gen(f).match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const`))[1];
  const m = blk.match(new RegExp(`"${key}": "([^"]*)"`));
  if (!m) throw new Error(`${f}:${name}.${key}`);
  return m[1];
};

let html = fs.readFileSync(path.join(HERE, "page.src.html"), "utf8");
html = html.replace(/\{\{(\w[\w-]*)\.(\w+)(?:\.(\w[\w-]*))?\}\}/g, (_, f, n, k) => (k ? objv(f, n, k) : str(f, n)));
fs.writeFileSync(path.join(HERE, "index.html"), html);

const input = `@import "tailwindcss";
@import "tw-animate-css";
@import "${KIT}/styles/tokens.css";
`;
const c = await compile(input, { base: SPEC, onDependency() {} });
const sc = new Scanner({ sources: [{ base: HERE, pattern: "index.html", negated: false }] });
let css = c.build(sc.scan());

// .rm mirrors every prefers-reduced-motion block so the toggle can show the reduced variants
const root = postcss.parse(css);
const clones = [];
root.walkAtRules("media", (at) => {
  if (!/prefers-reduced-motion:\s*reduce/.test(at.params)) return;
  at.walkRules((r) => {
    if (r.parent.type === "atrule" && r.parent.name === "keyframes") return;
    const cl = r.clone();
    cl.selectors = r.selectors.map((s) => `html.rm ${s}`);
    clones.push(cl);
  });
});
for (const cl of clones) root.append(cl);
fs.writeFileSync(path.join(HERE, "kit.css"), root.toString());
console.log("ok", css.length, "reduced clones:", clones.length);
