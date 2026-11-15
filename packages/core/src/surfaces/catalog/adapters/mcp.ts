import type { z } from "zod";

import { errorMessage } from "../../../shared/errors.js";
import { confinePaths, getAllowedRoots, PathNotAllowedError } from "../../../shared/path-guard.js";
import { redactSecrets } from "../../../shared/redact.js";
import { type ApiDeps, defaultApiDeps } from "../api-deps.js";
import type { Operation } from "../define-operation.js";
import { OPERATIONS } from "../operations.js";
import { inputJsonSchema } from "../schema.js";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Shape of `structuredContent` on success. */
  outputSchema: Record<string, unknown>;
  annotations: Operation["annotations"] & { title: string };
}

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  /** The result as an object a host can use without parsing text. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Structured content must be an object, so a list result is wrapped as `{ items }`. */
const isListResponse = (operation: Operation): boolean =>
  operation.response.schema["type"] === "array";

export function toStructured(operation: Operation, result: unknown): Record<string, unknown> {
  if (isListResponse(operation)) return { items: result };
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result };
}

export function toOutputSchema(operation: Operation): Record<string, unknown> {
  return isListResponse(operation)
    ? { type: "object", properties: { items: operation.response.schema }, required: ["items"] }
    : operation.response.schema;
}

/** The operations exposed as MCP tools. */
export const mcpOperations: readonly Operation[] = OPERATIONS.filter((operation) => operation.mcp);

export function toInputSchema(operation: Operation): McpTool["inputSchema"] {
  const json = inputJsonSchema(operation);
  return {
    type: "object",
    properties: json.properties ?? {},
    ...(json.required?.length ? { required: json.required } : {}),
  };
}

export function toMcpTools(operations: readonly Operation[] = mcpOperations): McpTool[] {
  return operations.map((operation) => ({
    name: operation.name,
    title: operation.title,
    description: operation.description,
    inputSchema: toInputSchema(operation),
    outputSchema: toOutputSchema(operation),
    annotations: { ...operation.annotations, title: operation.title },
  }));
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      if (issue.code === "unrecognized_keys") {
        return `${where}unknown field(s) ${issue.keys.map((key) => `"${key}"`).join(", ")}`;
      }
      return `${where}${issue.message}`;
    })
    .join("; ");
}

const success = (operation: Operation, value: unknown): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: toStructured(operation, value),
});

export interface CallOptions {
  operations?: readonly Operation[];
  /** Roots the MCP client declared (`roots/list`); added to the server's own working directory. */
  clientRoots?: readonly string[];
  /** Environment used to read `AUTOREMEDIATOR_ALLOWED_ROOTS`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Asked before an operation that changes the project runs (after its input is validated). Return
   * false to stop it; the caller sees that the user declined.
   */
  confirm?: (operation: Operation, input: Record<string, unknown>) => Promise<boolean>;
}

/** An operation that edits the project unless it is told not to. */
export const changesProject = (operation: Operation): boolean =>
  !operation.annotations.readOnlyHint &&
  (operation.annotations.destructiveHint || operation.runsProjectCode === true);

const errorResult = (message: string): McpToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Validate a tool call against the operation's input schema, confine its paths, and run it.
 * Invalid input, forbidden paths and failures come back as `isError` results rather than protocol
 * errors, so a host can show them to the model.
 */
export async function callMcpOperation(
  name: string,
  args: Record<string, unknown> = {},
  deps: ApiDeps = defaultApiDeps,
  options: CallOptions = {},
): Promise<McpToolResult> {
  const operations = options.operations ?? mcpOperations;
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) return errorResult(`Unknown tool: ${name}`);

  const parsed = operation.input.safeParse(args);
  if (!parsed.success) return errorResult(JSON.stringify({ error: describeIssues(parsed.error) }));

  let input: typeof parsed.data;
  try {
    input = confinePaths(
      inputJsonSchema(operation),
      parsed.data,
      getAllowedRoots(options.env, options.clientRoots),
    );
  } catch (err) {
    if (err instanceof PathNotAllowedError)
      return errorResult(JSON.stringify({ error: err.message }));
    throw err;
  }

  if (options.confirm && changesProject(operation)) {
    let approved: boolean;
    try {
      approved = await options.confirm(operation, input);
    } catch (err) {
      return errorResult(errorMessage(err));
    }
    if (!approved)
      return errorResult(`${operation.title} was declined by the user; nothing was changed.`);
  }

  try {
    const result = await operation.handler(input, {
      api: deps,
      source: "mcp",
      operationNames: operations.map((candidate) => candidate.name),
    });
    return success(operation, result);
  } catch (err) {
    return errorResult(redactSecrets(errorMessage(err)));
  }
}
