/**
 * `node --import autoremediator/trace ...` (or `--require`, or NODE_OPTIONS) loads this file. It
 * installs the trace hook when AUTOREMEDIATOR_TRACE_FILE is set and does nothing otherwise.
 * It exports nothing and must never throw: a tracing problem is not the program's problem.
 */
import { installTraceHook, optionsFromEnv } from "./runtime.js";

try {
  const options = optionsFromEnv();
  if (options) installTraceHook(options);
} catch {
  // Fail open.
}
