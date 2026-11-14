#!/usr/bin/env node

import { Command } from "commander";
import { createProgram as createCliProgram } from "./program.js";
import { isEntrypoint } from "../platform/entrypoint.js";

export function createProgram(): Command {
  return createCliProgram();
}

async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[autoremediator] ${message}\n`);
    process.exit(1);
  });
}
