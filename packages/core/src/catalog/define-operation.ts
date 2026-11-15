import type { z } from "zod";

import type { ApiDeps } from "./api-deps.js";
import type { ResponseSpec } from "./responses.js";

export type OperationSource = "cli" | "sdk" | "mcp" | "openapi";

/** Behaviour hints a host uses to decide whether a call needs approval (MCP tool annotations). */
export interface OperationAnnotations {
  /** The operation changes nothing in the project or its environment. */
  readOnlyHint: boolean;
  /** The operation may modify or remove existing files. */
  destructiveHint: boolean;
  /** Repeating the call with the same input has no further effect. */
  idempotentHint: boolean;
  /** The operation talks to external services. */
  openWorldHint: boolean;
}

/** Where an operation is (or is meant to be) reachable over HTTP. */
export interface HttpBinding {
  method: "GET" | "POST";
  path: string;
  /** Body fields that sit at the top level; every other input field nests under `options`. */
  positional?: readonly string[];
  /** `GET` only: input field carried in the path as `:name`. */
  pathParam?: string;
  status?: 200 | 202;
}

export interface OperationContext {
  /** The SDK functions the operation calls; replaceable for tests and embedding. */
  api: ApiDeps;
  /** Which surface the call arrived on; recorded as provenance. */
  source: OperationSource;
  /** Names of every operation reachable on the calling surface. */
  operationNames: readonly string[];
}

/**
 * One capability, defined once. MCP tools, HTTP routes, CLI commands and SDK entry points are
 * generated from these definitions, so their names, inputs and descriptions cannot drift apart.
 */
export interface Operation {
  /** Canonical camelCase name, e.g. `planRemediation`. */
  name: string;
  title: string;
  description: string;
  /** Flat input object. HTTP nests everything outside `http.positional` under `options`. */
  input: z.ZodObject;
  annotations: OperationAnnotations;
  /**
   * The operation runs code that belongs to the project or a dependency (installs, the project's
   * tests, a reproduction script) or edits files that get run. Such a call can read every secret
   * the server holds, so it needs the `admin` role whatever its annotations say.
   */
  runsProjectCode?: boolean;
  /** What a successful call returns, as the OpenAPI document describes it. */
  response: ResponseSpec;
  /** Expose as an MCP tool. */
  mcp: boolean;
  http?: HttpBinding;
  handler(input: Record<string, unknown>, context: OperationContext): unknown;
}

export interface OperationDefinition<I extends z.ZodObject> extends Omit<
  Operation,
  "input" | "handler"
> {
  input: I;
  handler(input: z.output<I>, context: OperationContext): unknown;
}

/** Define an operation with a handler typed by its own input schema. */
export function defineOperation<I extends z.ZodObject>(
  definition: OperationDefinition<I>,
): Operation {
  return {
    ...definition,
    // Input is validated against `definition.input` before any handler runs.
    handler: (input, context) => definition.handler(input as z.output<I>, context),
  };
}
