import { applyPlan, getRun, readAttemptArtifact } from "autoremediator";

import { MODE_DESCRIPTIONS } from "../mode-info.ts";
import { describeRun, planTask } from "./plan.ts";
import type { Mode } from "./types.ts";

/**
 * The built-in repair agent with a real model: `autoremediator runs apply --model <spec>`, driven
 * through the SDK. It needs the provider package (`@ai-sdk/<provider>`) and its API key in the
 * environment, and it sends the project's source to the provider. It is never part of `pnpm bench`
 * by default; run it with `pnpm bench --mode agent-model --model anthropic:<model-id>`.
 *
 * This is the only mode whose result says anything about a model. Token counts come from the
 * attempt records the run wrote, so they are real.
 */
export const agentModel: Mode = {
  name: "agent-model",
  description: MODE_DESCRIPTIONS["agent-model"],
  async run(context) {
    const { project, model } = context;
    if (!model) {
      throw new Error(
        "agent-model needs --model <provider>:<model-id> (and the provider's API key in the environment).",
      );
    }
    const planned = await planTask(context);
    const applied = await applyPlan({
      cwd: project.dir,
      runId: planned.runId,
      model,
      repair: true,
    });
    const described = describeRun(applied);

    const attempts = getRun({ cwd: project.dir, runId: planned.runId }).attempts;
    const notes = [...planned.notes, ...described.notes];
    let steps = 0;
    let input = 0;
    let output = 0;
    let agentClaimed: boolean | undefined;
    for (const attempt of attempts) {
      const transcript =
        readAttemptArtifact({
          cwd: project.dir,
          runId: planned.runId,
          attemptId: attempt.attemptId,
          artifact: "transcript",
        }) ?? "";
      // One transcript line per tool call; text-only lines have no call.
      steps += transcript
        .split("\n")
        .filter((line) => /^\{"step":\d+,"text":"\w+\(/.test(line)).length;
      input += attempt.inputTokens ?? 0;
      output += attempt.outputTokens ?? 0;
      agentClaimed = (agentClaimed ?? false) || transcript.includes("submit(");
      notes.push(
        `attempt ${attempt.attemptId}: ${attempt.status} after ${attempt.rounds} round(s): ${attempt.reason.slice(0, 240)}`,
      );
    }

    return {
      claimedSuccess: described.claimed,
      unresolvedReasons: [...planned.reasons, ...described.reasons],
      steps,
      ...(agentClaimed === undefined ? {} : { agentClaimedSuccess: agentClaimed }),
      ...(attempts.length > 0 ? { tokens: { input, output } } : {}),
      notes,
    };
  },
};
