import { applyPlan } from "autoremediator";

import { MODE_DESCRIPTIONS } from "../mode-info.ts";
import { describeRun, planTask } from "./plan.ts";
import type { Mode } from "./types.ts";

/** The plan/apply pipeline with no model: version bump or override, verified, rolled back on failure. */
export const deterministic: Mode = {
  name: "deterministic",
  description: MODE_DESCRIPTIONS["deterministic"],
  async run(context) {
    const { project } = context;
    const planned = await planTask(context);
    const applied = await applyPlan({ cwd: project.dir, runId: planned.runId, repair: false });
    const described = describeRun(applied);
    return {
      claimedSuccess: described.claimed,
      unresolvedReasons: [...planned.reasons, ...described.reasons],
      steps: 0,
      notes: [...planned.notes, ...described.notes],
    };
  },
};
