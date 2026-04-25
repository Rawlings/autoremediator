import { tool } from "ai";
import type { z } from "zod";

type AnyZodSchema = z.ZodTypeAny;

interface CompatToolConfig<TSchema extends AnyZodSchema, TResult> {
  description: string;
  parameters: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<TResult> | TResult;
}

export function defineTool<TSchema extends AnyZodSchema, TResult>(
  config: CompatToolConfig<TSchema, TResult>
) {
  return tool(config as any);
}
