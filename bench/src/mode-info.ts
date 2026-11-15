import type { ModeName } from "./task.ts";

/** What a result from each mode does and does not measure. Printed with the results. */
export const MODE_DESCRIPTIONS: Record<ModeName, string> = {
  deterministic:
    "The plan and apply pipeline with no model and no agent. Tasks that need a change to the project's own source are expected to fail here: the pipeline rolls the upgrade back and reports it unresolved.",
  "agent-scripted":
    "The built-in repair agent loop (tools, scope guard, verifier gate, promotion) driven by a scripted mock model that is handed the known-good fix. It measures the harness, not model quality: a PASS here says the machinery lets a correct repair through and stops a wrong one, nothing about any real model.",
  "host-scripted":
    "A scripted MCP client over stdio driving startAttempt, proposePatch, verifyAttempt and finalizeAttempt the way a host agent would, handed the known-good diff. It measures the tools, the isolated checkout and the verifier gate, not the quality of any host agent. Steps count MCP tool calls.",
  "agent-model":
    "The built-in repair agent with a real model, sending the fixture projects' source to its provider. This is the only mode that measures a model; its results file names the model.",
};
