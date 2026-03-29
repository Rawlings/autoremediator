#!/usr/bin/env node

import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { createProgram as createCliProgram } from "./program.js";

export function createProgram(): Command {
  return createCliProgram();
}

async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[autoremediator] ${message}\n`);
    process.exit(1);
  });
}
