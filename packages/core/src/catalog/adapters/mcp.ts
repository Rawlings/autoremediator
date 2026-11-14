import type { z } from "zod";

import { assertPathsConfined, getAllowedRoots, PathNotAllowedError } from "../../platform/path-guard.js";
import { type ApiDeps, defaultApiDeps } from "../api-deps.js";
import type { Operation } from "../define-operation.js";
import { OPERATIONS } from "../operations.js";
import { inputJsonSchema } from "../schema.js";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: Operation["annotations"] & { title: string };
}

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

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

const text = (value: unknown): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

export interface CallOptions {
  operations?: readonly Operation[];
  /** Roots the MCP client declared (`roots/list`); added to the server's own working directory. */
  clientRoots?: readonly string[];
  /** Environment used to read `AUTOREMEDIATOR_ALLOWED_ROOTS`. */
  env?: NodeJS.ProcessEnv;
}

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

  try {
    assertPathsConfined(
      inputJsonSchema(operation),
      parsed.data,
      getAllowedRoots(options.env, options.clientRoots),
    );
  } catch (err) {
    if (err instanceof PathNotAllowedError) return errorResult(JSON.stringify({ error: err.message }));
    throw err;
  }

  try {
    const result = await operation.handler(parsed.data, {
      api: deps,
      source: "mcp",
      operationNames: operations.map((candidate) => candidate.name),
    });
    return text(result);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
