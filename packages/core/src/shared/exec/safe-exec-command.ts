import type { ResultPromise } from "execa";

import { type SafeExecOptions, safeExeca } from "./safe-exec.js";

/**
 * Runs a command given as an argv array (`[executable, ...args]`) through `safeExeca`.
 * Throws when the array is empty instead of passing an undefined executable downstream.
 */
export function safeExecaCommand<OptionsType extends SafeExecOptions = SafeExecOptions>(
  command: readonly string[],
  options?: OptionsType,
): ResultPromise<OptionsType> {
  const [file, ...args] = command;
  if (file === undefined) {
    throw new Error("Command execution blocked: command is empty");
  }
  return safeExeca(file, args, options);
}
