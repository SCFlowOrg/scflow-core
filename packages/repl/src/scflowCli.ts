#!/usr/bin/env node
import * as readline from "node:readline";
import { runScflow } from "./scflow.js";

process.exitCode = await runScflow(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  lines: readline.createInterface({ input: process.stdin }),
});
