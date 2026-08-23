import { tool } from "ai";
import type { z } from "zod";

type AnyZodSchema = z.ZodTypeAny;

export interface CompatToolConfig<TSchema extends AnyZodSchema, TResult> {
  description: string;
  parameters: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<TResult> | TResult;
}

export type ExecutableTool<TSchema extends AnyZodSchema, TResult> = {
  description: string;
  parameters: TSchema;
  execute: (input: z.input<TSchema>) => Promise<TResult>;
};

export function defineTool<TSchema extends AnyZodSchema, TResult>(
  config: CompatToolConfig<TSchema, TResult>,
): ExecutableTool<TSchema, TResult> {
  return tool(config as any) as unknown as ExecutableTool<TSchema, TResult>;
}
