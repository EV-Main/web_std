#!/usr/bin/env node
import { runTranslate, runCli } from "../dist/extract.js";

runCli("evinvest-i18n-translate", () => runTranslate(process.argv.slice(2)));
