#!/usr/bin/env node

import type { Command } from "commander";

import { EXIT_CODES } from "../api/reporting.js";
import { isEntrypoint } from "../platform/entrypoint.js";
import { formatCliError, wantsJson } from "./errors.js";
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
    process.stderr.write(formatCliError(error, wantsJson(process.argv)));
    process.exit(EXIT_CODES.failed);
  });
}
