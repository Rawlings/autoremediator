import type { LoadedTask } from "./task.ts";

type ToolCall = [name: string, input: object];

/** One scripted model turn that calls tools. */
export function turn(...calls: ToolCall[]) {
  return {
    content: calls.map(([toolName, input], index) => ({
      type: "tool-call" as const,
      toolCallId: `call-${toolName}-${index}`,
      toolName,
      input: JSON.stringify(input),
    })),
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 0, text: 0, reasoning: undefined },
    },
    warnings: [],
  };
}

/**
 * The scripted model's turns. `oracle` replays the known-good repair stored with the task: read
 * what is there, read the dependency's upgrade notes, write the fixed files, run the project's
 * checks, submit. `false-claim` reads a file and then says it is done without changing anything,
 * every time it is asked. A task that needs no repair gets a model that gives up, so an unexpected
 * call to the agent is visible instead of silently succeeding.
 */
export function scriptFor(task: LoadedTask): ReturnType<typeof turn>[] {
  if (task.control?.kind === "false-claim") {
    const [first] = [...task.oracleFiles.keys()];
    const read = turn(["readFile", { path: first ?? "package.json" }]);
    const claim = () =>
      turn([
        "submit",
        { summary: "Updated the call site for the new version. Type check and tests pass." },
      ]);
    return [read, claim(), claim(), claim(), claim()];
  }
  if (task.oracleFiles.size === 0) {
    return [turn(["giveUp", { reason: "no scripted repair exists for this task" }])];
  }
  const paths = [...task.oracleFiles.keys()];
  return [
    turn(...paths.map((path): ToolCall => ["readFile", { path }])),
    turn(["readPackageDocs", { packageName: task.vulnerable.packageName }]),
    turn(
      ...[...task.oracleFiles].map(([path, content]): ToolCall => ["writeFile", { path, content }]),
    ),
    turn(["runCheck", { name: "typecheck" }]),
    turn(["runCheck", { name: "tests" }]),
    turn([
      "submit",
      { summary: "Adapted the project's source to the new API of the upgraded dependency." },
    ]),
  ];
}
