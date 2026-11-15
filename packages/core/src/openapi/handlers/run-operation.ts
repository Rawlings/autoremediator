import type http from "node:http";

import { defaultApiDeps, httpOperations, type Operation } from "../../catalog/index.js";
import { publicErrorMessage, sendJson } from "../http-utils.js";
import type { OpenApiServerDeps } from "../server.js";

function describeIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string; code: string; keys?: string[] }>;
}): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      if (issue.code === "unrecognized_keys" && issue.keys) {
        return `${where}unknown field(s) ${issue.keys.map((key) => `"${key}"`).join(", ")}`;
      }
      return `${where}${issue.message}`;
    })
    .join("; ");
}

/** Validate, confine and run one operation, answering the request with its result or an error. */
export async function runOperation(
  operation: Operation,
  input: Record<string, unknown>,
  deps: OpenApiServerDeps,
  res: http.ServerResponse,
  guard: { confine<T>(input: T): T; isPathError(error: unknown): boolean },
): Promise<void> {
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) {
    sendJson(res, 400, { error: describeIssues(parsed.error) });
    return;
  }

  let confined: typeof parsed.data;
  try {
    confined = guard.confine(parsed.data);
  } catch (error) {
    if (guard.isPathError(error)) {
      sendJson(res, 403, { error: publicErrorMessage(error) });
      return;
    }
    throw error;
  }

  try {
    const result = await operation.handler(confined, {
      api: { ...defaultApiDeps, ...deps },
      source: "openapi",
      operationNames: httpOperations.map((candidate) => candidate.name),
    });
    sendJson(res, operation.http?.status ?? 200, result);
  } catch (error) {
    const message = publicErrorMessage(error);
    // A lookup by id that finds nothing is a 404; any other failure is a rejected request.
    sendJson(res, operation.http?.pathParam ? 404 : 400, { error: message });
  }
}
