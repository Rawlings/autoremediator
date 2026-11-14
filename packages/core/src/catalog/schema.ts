import { z } from "zod";

import type { Operation } from "./define-operation.js";

export type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  [keyword: string]: unknown;
};

const cache = new WeakMap<Operation, JsonSchemaObject>();

/** The operation's flat input as JSON Schema (generated once from the zod definition). */
export function inputJsonSchema(operation: Operation): JsonSchemaObject {
  let schema = cache.get(operation);
  if (!schema) {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(operation.input, { io: "input" });
    schema = rest as JsonSchemaObject;
    cache.set(operation, schema);
  }
  return schema;
}
