import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { FIGMA_SUITE } from "./index";
import { render, type Target } from "./render";

const USAGE = `usage: evinvest-figma-render -c <playwright config> --file <figma fileKey>
       evinvest-figma-render -c <playwright config> --folder <figma folder URL> --name <file name>   (over --file)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { config: { type: "string", short: "c" }, file: { type: "string" }, folder: { type: "string" }, name: { type: "string" } },
});
const { config, file, folder, name } = values;
const target: Target | undefined =
  folder !== undefined ? (name === undefined ? undefined : { folder, name })
  : name !== undefined ? undefined
  : file !== undefined ? { file }
  : undefined;
if (config === undefined || positionals.length > 0 || target === undefined) {
  console.error(USAGE);
  process.exit(1);
}

// `playwright` is the caller's PATH's: the pinned runner its browsers match. stdout carries only the page link.
const run = (issuer: string) =>
  new Promise<number>((done, fail) =>
    spawn("playwright", ["test", "-c", config, "--grep", FIGMA_SUITE], { stdio: ["inherit", 2, "inherit"], env: { ...process.env, FIGMA_ISSUER: issuer } })
      .on("error", fail)
      .on("exit", code => done(code ?? 1)),
  );
process.exit(await render(target, run));
