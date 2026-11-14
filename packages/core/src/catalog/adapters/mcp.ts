import { z } from "zod";

import { type ApiDeps, defaultApiDeps } from "../api-deps.js";
import type { Operation } from "../define-operation.js";
import { OPERATIONS } from "../operations.js";

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

export function toInputSchema(schema: z.ZodObject): McpTool["inputSchema"] {
  const json = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
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
    inputSchema: toInputSchema(operation.input),
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

/**
 * Validate a tool call against the operation's input schema and run it. Invalid input and
 * failures come back as `isError` results rather than protocol errors, so a host can show them to
 * the model.
 */
export async function callMcpOperation(
  name: string,
  args: Record<string, unknown> = {},
  deps: ApiDeps = defaultApiDeps,
  operations: readonly Operation[] = mcpOperations,
): Promise<McpToolResult> {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  const parsed = operation.input.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: describeIssues(parsed.error) }) }],
      isError: true,
    };
  }

  try {
    const result = await operation.handler(parsed.data, {
      api: deps,
      source: "mcp",
      operationNames: operations.map((candidate) => candidate.name),
    });
    return text(result);
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}
