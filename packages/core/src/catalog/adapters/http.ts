

import type { Operation } from "../define-operation.js";
import { ERROR_RESPONSE_SCHEMA, RESPONSES } from "../responses.js";
import { OPERATIONS } from "../operations.js";
import { inputJsonSchema, type JsonSchemaObject } from "../schema.js";

export type HttpRole = "reader" | "operator" | "admin";

/** The operations served over HTTP, with their route bindings. */
export const httpOperations: readonly Operation[] = OPERATIONS.filter(
  (operation) => operation.http !== undefined,
);

/** Route key used for access control: dynamic segments are dropped (`GET /jobs/:jobId` → `GET /jobs`). */
export function routeKey(operation: Operation): string {
  const { method, path } = operation.http!;
  return `${method} ${path.replace(/\/:[^/]+$/, "")}`;
}

/** Minimum role: read-only operations need `reader`, anything that edits the project `admin`. */
export function roleFor(operation: Operation): HttpRole {
  if (operation.annotations.readOnlyHint) return "reader";
  return operation.annotations.destructiveHint ? "admin" : "operator";
}

export function matchHttpRoute(
  method: string,
  pathname: string,
  operations: readonly Operation[] = httpOperations,
): { operation: Operation; params: Record<string, string> } | undefined {
  const requested = pathname.split("/");
  for (const operation of operations) {
    const binding = operation.http!;
    if (binding.method !== method) continue;
    const template = binding.path.split("/");
    if (template.length !== requested.length) continue;

    const params: Record<string, string> = {};
    const matches = template.every((segment, index) => {
      const actual = requested[index] ?? "";
      if (segment.startsWith(":")) {
        if (actual === "") return false;
        try {
          params[segment.slice(1)] = decodeURIComponent(actual);
        } catch {
          return false;
        }
        return true;
      }
      return segment === actual;
    });
    if (matches) return { operation, params };
  }
  return undefined;
}

export type RequestMapping = { ok: true; input: Record<string, unknown> } | { ok: false; error: string };

/**
 * Turn an HTTP request into the operation's flat input. Fields named in `http.positional` sit at the
 * top level of the body; everything else nests under `options`.
 */
export function mapRequestToInput(
  operation: Operation,
  body: unknown,
  params: Record<string, string> = {},
): RequestMapping {
  const binding = operation.http!;
  if (binding.method === "GET") return { ok: true, input: params };

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Invalid JSON body" };
  }
  const record = body as Record<string, unknown>;
  const positional = new Set(binding.positional ?? []);

  const unknown = Object.keys(record).filter((key) => key !== "options" && !positional.has(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown field(s) ${unknown.map((key) => `"${key}"`).join(", ")} (option fields belong under "options")`,
    };
  }

  const options = record["options"] ?? {};
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return { ok: false, error: "options must be an object" };
  }

  const lifted: Record<string, unknown> = {};
  for (const key of positional) {
    if (key in record) lifted[key] = record[key];
  }
  const clash = Object.keys(lifted).find((key) => key in options);
  if (clash) return { ok: false, error: `"${clash}" belongs at the top level, not under "options"` };

  return { ok: true, input: { ...options, ...lifted } };
}

// ---------------------------------------------------------------------------
// OpenAPI document
// ---------------------------------------------------------------------------

const json = (schema: unknown) => ({ "application/json": { schema } });
const errorResponse = (description: string) => ({ description, content: json(ERROR_RESPONSE_SCHEMA) });

function pick(properties: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.flatMap((key) => (key in properties ? [[key, properties[key]]] : [])));
}

function requestBodySchema(operation: Operation, schema: JsonSchemaObject) {
  const positional = operation.http?.positional ?? [];
  const properties = schema.properties ?? {};
  const required = (schema.required ?? []).filter((key) => positional.includes(key));
  const optionKeys = Object.keys(properties).filter((key) => !positional.includes(key));

  return {
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties: {
      ...pick(properties, positional),
      ...(optionKeys.length > 0
        ? {
            options: {
              type: "object",
              properties: pick(properties, optionKeys),
              additionalProperties: false,
            },
          }
        : {}),
    },
    additionalProperties: false,
  };
}

function toOpenApiOperation(operation: Operation) {
  const binding = operation.http!;
  const schema = inputJsonSchema(operation);
  const status = String(binding.status ?? 200);

  const responses: Record<string, unknown> = {
    [status]: { description: operation.response.description, content: json(operation.response.schema) },
    "400": errorResponse("Invalid input or operation error"),
    "403": errorResponse("A path argument is outside the server's allowed roots"),
  };

  if (binding.pathParam) {
    responses["404"] = errorResponse("Not found");
    return {
      operationId: operation.name,
      summary: operation.title,
      description: operation.description,
      parameters: [
        {
          name: binding.pathParam,
          in: "path",
          required: true,
          schema: { type: "string" },
          description: (schema.properties?.[binding.pathParam]?.["description"] as string) ?? undefined,
        },
      ],
      responses,
    };
  }

  const body = requestBodySchema(operation, schema);
  return {
    operationId: operation.name,
    summary: operation.title,
    description: operation.description,
    requestBody: { required: Array.isArray(body.required), content: json(body) },
    responses,
  };
}

/** `/jobs/:jobId` → `/jobs/{jobId}` */
const toOpenApiPath = (path: string) => path.replaceAll(/:([^/]+)/g, "{$1}");

/** OpenAPI `paths`, generated from the catalog plus the two operation-less endpoints. */
export function toOpenApiPaths(
  operations: readonly Operation[] = httpOperations,
): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {
    "/openapi.json": {
      get: {
        operationId: "openapiJson",
        summary: "Get the OpenAPI specification document",
        responses: { "200": { description: "OpenAPI specification", content: json({ type: "object" }) } },
      },
    },
    "/health": {
      get: {
        operationId: "health",
        summary: "Health check",
        responses: {
          "200": { description: RESPONSES.health.description, content: json(RESPONSES.health.schema) },
        },
      },
    },
  };

  for (const operation of operations) {
    const path = toOpenApiPath(operation.http!.path);
    paths[path] = {
      ...paths[path],
      [operation.http!.method.toLowerCase()]: toOpenApiOperation(operation),
    };
  }
  return paths;
}

