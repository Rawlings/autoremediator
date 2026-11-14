#!/usr/bin/env node

import type { Command } from "commander";

import { isEntrypoint } from "../platform/entrypoint.js";
import { createProgram as createCliProgram } from "./program.js";

export function createProgram(): Command {
  return createCliProgram();
}

async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[autoremediator] ${message}\n`);
    process.exit(1);
  });
}
