#!/usr/bin/env node
import { runRekey, runCli } from "../dist/extract.js";

runCli("evinvest-i18n-rekey", () => runRekey(process.argv.slice(2)));
