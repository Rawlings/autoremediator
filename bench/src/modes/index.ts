import type { ModeName } from "../task.ts";
import { agentModel } from "./agent-model.ts";
import { agentScripted } from "./agent-scripted.ts";
import { deterministic } from "./deterministic.ts";
import { hostScripted } from "./host-scripted.ts";
import type { Mode } from "./types.ts";

export const MODES: Record<ModeName, Mode> = {
  deterministic,
  "agent-scripted": agentScripted,
  "host-scripted": hostScripted,
  "agent-model": agentModel,
};

/** The modes that need no key, no network and no model: what a bare `pnpm bench` runs. */
export const DEFAULT_MODES: readonly ModeName[] = [
  "deterministic",
  "agent-scripted",
  "host-scripted",
];
