import type { z } from "zod";

type AnySchema = z.ZodTypeAny;

export interface ToolDefinition<TSchema extends AnySchema, TResult> {
  description: string;
  inputSchema: TSchema;
  /** Receives the parsed input: defaults applied, unknown keys stripped. */
  execute: (input: z.output<TSchema>) => Promise<TResult> | TResult;
}

export interface Tool<TSchema extends AnySchema, TResult> {
  description: string;
  inputSchema: TSchema;
  /** Validates the input against `inputSchema` (throwing a ZodError on mismatch), then runs the tool. */
  execute: (input: z.input<TSchema>) => Promise<TResult>;
}

export function defineTool<TSchema extends AnySchema, TResult>(
  definition: ToolDefinition<TSchema, TResult>,
): Tool<TSchema, TResult> {
  return {
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: async (input) => definition.execute(definition.inputSchema.parse(input)),
  };
}
