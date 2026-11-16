import { MockLanguageModelV4 } from "ai/test";
import { applyPlan, getRun, readAttemptArtifact } from "autoremediator";

// The built-in agent is internal to the package (not part of its public API). The benchmark lives
// in the same repository and scores that loop on purpose, so it imports the built file directly.
import { createBuiltinRepairAgent } from "../../../core/dist/features/repair/builtin-agent.js";
import { MODE_DESCRIPTIONS } from "../mode-info.ts";
import { scriptFor } from "../script.ts";
import { describeRun, planTask } from "./plan.ts";
import type { Mode } from "./types.ts";

/**
 * The built-in repair agent loop, driven by a scripted model that is handed the right answer. This
 * measures the harness around the model (the tools and their scope guard, the verifier that judges
 * every submission, the promotion into the project), not how good any model is.
 */
export const agentScripted: Mode = {
  name: "agent-scripted",
  description: MODE_DESCRIPTIONS["agent-scripted"],
  async run(context) {
    const { task, project } = context;
    const planned = await planTask(context);

    const model = new MockLanguageModelV4({
      modelId: "scripted-oracle",
      doGenerate: scriptFor(task),
    });
    const applied = await applyPlan({
      cwd: project.dir,
      runId: planned.runId,
      repairAgent: createBuiltinRepairAgent(model),
    });
    const described = describeRun(applied);

    const attempts = getRun({ cwd: project.dir, runId: planned.runId }).attempts;
    const notes = [...planned.notes, ...described.notes];
    let agentClaimed: boolean | undefined;
    for (const attempt of attempts) {
      const transcript =
        readAttemptArtifact({
          cwd: project.dir,
          runId: planned.runId,
          attemptId: attempt.attemptId,
          artifact: "transcript",
        }) ?? "";
      agentClaimed = (agentClaimed ?? false) || transcript.includes("submit(");
      notes.push(
        `attempt ${attempt.attemptId}: ${attempt.status} after ${attempt.rounds} round(s): ${attempt.reason.slice(0, 240)}`,
      );
    }

    return {
      claimedSuccess: described.claimed,
      unresolvedReasons: [...planned.reasons, ...described.reasons],
      steps: model.doGenerateCalls.length,
      ...(agentClaimed === undefined ? {} : { agentClaimedSuccess: agentClaimed }),
      notes,
    };
  },
};
