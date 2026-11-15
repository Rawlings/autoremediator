/**
 * A2A over the HTTP server: the public Agent Card, and a JSON-RPC 2.0 endpoint implementing the two
 * methods of the 1.0 binding autoremediator supports, `SendMessage` and `GetTask`.
 *
 * A `SendMessage` message carries a data part `{"operation": <skill id>, "input": {...}}`. The
 * operation runs to completion before the reply, so a reply is always a task in a terminal state.
 * Authorization is the HTTP API's: the same bearer tokens, the role `roleFor` assigns the operation,
 * and the same path confinement.
 */
import { randomUUID } from "node:crypto";
import type http from "node:http";

import { authorizeRole, callerIdentity, type Role } from "../../infra/http/http-auth.js";
import { HttpError, readBody, sendJson } from "../../infra/http/http-security.js";
import { errorMessage } from "../../shared/errors.js";
import { isRecord } from "../../shared/guards.js";
import { confinePaths, getAllowedRoots, PathNotAllowedError } from "../../shared/path-guard.js";
import { redactSecrets } from "../../shared/redact.js";
import { PACKAGE_VERSION } from "../../shared/version.js";
import {
  defaultApiDeps,
  inputJsonSchema,
  roleFor,
  type ApiDeps,
  type Operation,
} from "../catalog/index.js";
import {
  A2A_PROTOCOL_VERSION,
  a2aSkillOperations,
  buildAgentCard,
  normalizeBaseUrl,
  type AgentCard,
} from "./agent-card.js";
import { signAgentCard, signingKeyFromEnv } from "./sign.js";
import { TaskStore, truncateMessage } from "./task-store.js";

const JSON_MEDIA_TYPE = "application/json";

/** JSON-RPC 2.0 and A2A error codes (A2A 1.0 sections 5.4 and 9.5). */
const ERROR = {
  parse: -32_700,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602,
  taskNotFound: -32_001,
  unsupportedOperation: -32_004,
  contentTypeNotSupported: -32_005,
  versionNotSupported: -32_009,
} as const;

type JsonRpcId = string | number | null;

type TaskState = "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED";

interface A2aPart {
  text?: string;
  data?: unknown;
  mediaType?: string;
}

interface A2aMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: string;
  parts: A2aPart[];
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: { state: TaskState; message?: A2aMessage; timestamp: string };
  artifacts?: Array<{ artifactId: string; name: string; parts: A2aPart[] }>;
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

const SAFE_HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

/**
 * The URL the card advertises: `AUTOREMEDIATOR_A2A_BASE_URL` when set (use it behind a TLS proxy),
 * otherwise the request's `Host` over http. The caller has already checked the host against the
 * allowed list; the shape check here keeps userinfo or paths out of the advertised URL.
 */
export function resolveBaseUrl(
  req: http.IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env["AUTOREMEDIATOR_A2A_BASE_URL"];
  if (configured) return normalizeBaseUrl(configured);
  const host = req.headers.host ?? "";
  return SAFE_HOST.test(host) ? `http://${host}` : "http://127.0.0.1";
}

/** The card for this request, signed when `AUTOREMEDIATOR_A2A_SIGNING_KEY` is set. */
export function agentCardFor(
  req: http.IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): AgentCard {
  const card = buildAgentCard({ baseUrl: resolveBaseUrl(req, env), version: PACKAGE_VERSION });
  const key = signingKeyFromEnv(env);
  return key ? signAgentCard(card, key) : card;
}

/** `GET /.well-known/agent-card.json`: public, like `/health` and `/openapi.json`. */
export function handleAgentCardRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, agentCardFor(req));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_TTL_MS = 60 * 60 * 1000;
/** One result larger than this is returned to its caller but not kept (4 MB). */
const MAX_TASK_BYTES = 4 * 1024 * 1024;

/** Finished tasks, in memory. Lost on restart; bounded by count, age and total size (64 MB). */
const tasks = new TaskStore<A2aTask>({
  maxTasks: 500,
  maxBytes: 64 * 1024 * 1024,
  ttlMs: TASK_TTL_MS,
});

/**
 * Keep a finished task for `GetTask`, for the caller that ran it only. The record holds a short copy
 * of the caller's message, not the message, and a result too big to keep is replaced by a notice.
 */
function rememberTask(task: A2aTask, role: Role, owner: string): void {
  const kept: A2aTask = {
    ...task,
    ...(task.history ? { history: task.history.map((message) => truncateMessage(message)) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(kept)) > MAX_TASK_BYTES && kept.artifacts) {
    kept.artifacts = kept.artifacts.map((artifact) => ({
      ...artifact,
      parts: [
        {
          data: { omitted: "The result was too large to keep; it was returned by SendMessage." },
          mediaType: JSON_MEDIA_TYPE,
        },
      ],
    }));
  }
  tasks.remember(kept, role, owner);
}

function trimHistory(task: A2aTask, historyLength: unknown): A2aTask {
  if (typeof historyLength !== "number" || !Number.isInteger(historyLength) || historyLength < 0) {
    return task;
  }
  const { history, ...rest } = task;
  if (historyLength === 0 || !history) return rest;
  return { ...rest, history: history.slice(-historyLength) };
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type Record_ = Record<string, unknown>;

function rpcError(res: http.ServerResponse, id: JsonRpcId, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function describeIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`,
    )
    .join("; ");
}

function requestedVersionIsSupported(req: http.IncomingMessage): boolean {
  const header = req.headers["a2a-version"];
  // Not sent: assume the version this agent implements. (The specification only says an empty
  // value means 0.3, so an absent header is a lenient reading.)
  if (header === undefined) return true;
  return (Array.isArray(header) ? header[0] : header) === A2A_PROTOCOL_VERSION;
}

function parseMessage(value: unknown): A2aMessage | string {
  if (!isRecord(value)) return "params.message is required (object)";
  if (typeof value["messageId"] !== "string" || value["messageId"] === "") {
    return "message.messageId is required (string)";
  }
  if (value["role"] !== "ROLE_USER") return 'message.role must be "ROLE_USER"';
  if (!Array.isArray(value["parts"]) || value["parts"].length === 0) {
    return "message.parts is required (non-empty array)";
  }
  return value as unknown as A2aMessage;
}

/** The `{operation, input}` object carried by the message's first data part. */
function findInvocation(message: A2aMessage): { operation: string; input: unknown } | string {
  for (const part of message.parts) {
    if (isRecord(part) && isRecord(part.data) && typeof part.data["operation"] === "string") {
      return { operation: part.data["operation"], input: part.data["input"] ?? {} };
    }
  }
  return 'message needs a data part {"operation": <skill id>, "input": {...}}';
}

function acceptsJson(configuration: unknown): boolean {
  if (!isRecord(configuration)) return true;
  const modes = configuration["acceptedOutputModes"];
  if (!Array.isArray(modes) || modes.length === 0) return true;
  return modes.some(
    (mode) => mode === JSON_MEDIA_TYPE || mode === "application/*" || mode === "*/*",
  );
}

/** Refuse (HTTP) when the caller's role is too low; returns whether the request may proceed. */
function authorize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  role: Role,
  label: string,
): boolean {
  const decision = authorizeRole(req, role, label);
  if (!decision.ok) sendJson(res, decision.status, { error: decision.error });
  return decision.ok;
}

async function sendMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: JsonRpcId,
  params: Record_,
  deps: Partial<ApiDeps>,
  operations: ReadonlyMap<string, Operation>,
): Promise<void> {
  const message = parseMessage(params["message"]);
  if (typeof message === "string") return rpcError(res, id, ERROR.invalidParams, message);
  if (message.taskId !== undefined) {
    return rpcError(
      res,
      id,
      ERROR.unsupportedOperation,
      "Continuing an existing task is not supported: every SendMessage starts a new task",
    );
  }
  if (!acceptsJson(params["configuration"])) {
    return rpcError(
      res,
      id,
      ERROR.contentTypeNotSupported,
      `Only ${JSON_MEDIA_TYPE} output is produced`,
    );
  }

  const invocation = findInvocation(message);
  if (typeof invocation === "string") return rpcError(res, id, ERROR.invalidParams, invocation);
  const operation = operations.get(invocation.operation);
  if (!operation) {
    return rpcError(
      res,
      id,
      ERROR.invalidParams,
      `Unknown operation "${invocation.operation}". Available: ${[...operations.keys()].join(", ")}`,
    );
  }
  if (!isRecord(invocation.input)) {
    return rpcError(res, id, ERROR.invalidParams, "input must be an object");
  }
  const parsed = operation.input.safeParse(invocation.input);
  if (!parsed.success) return rpcError(res, id, ERROR.invalidParams, describeIssues(parsed.error));

  const role = roleFor(operation);
  if (!authorize(req, res, role, `A2A SendMessage ${operation.name}`)) return;

  let confined: typeof parsed.data;
  try {
    confined = confinePaths(inputJsonSchema(operation), parsed.data, getAllowedRoots());
  } catch (error) {
    if (error instanceof PathNotAllowedError) {
      sendJson(res, 403, { error: error.message });
      return;
    }
    throw error;
  }

  const base = {
    id: randomUUID(),
    contextId: message.contextId ?? randomUUID(),
    history: [message],
    metadata: { operation: operation.name },
  };
  const timestamp = new Date().toISOString();
  let task: A2aTask;
  try {
    const result = await operation.handler(confined, {
      api: { ...defaultApiDeps, ...deps },
      source: "openapi",
      operationNames: [...operations.keys()],
    });
    // Round-trip so the artifact holds exactly what a JSON consumer would receive.
    const serialized = JSON.stringify(result ?? null);
    const data: unknown = JSON.parse(serialized);
    task = {
      ...base,
      status: { state: "TASK_STATE_COMPLETED", timestamp },
      artifacts: [
        {
          artifactId: randomUUID(),
          name: operation.name,
          parts: [{ data, mediaType: JSON_MEDIA_TYPE }],
        },
      ],
    };
  } catch (error) {
    const text = redactSecrets(errorMessage(error));
    task = {
      ...base,
      status: {
        state: "TASK_STATE_FAILED",
        message: {
          messageId: randomUUID(),
          contextId: base.contextId,
          taskId: base.id,
          role: "ROLE_AGENT",
          parts: [{ text }],
        },
        timestamp,
      },
    };
  }

  rememberTask(task, role, callerIdentity(req));
  const configuration = isRecord(params["configuration"]) ? params["configuration"] : {};
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id,
    result: { task: trimHistory(task, configuration["historyLength"]) },
  });
}

function getTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: JsonRpcId,
  params: Record_,
): void {
  if (typeof params["id"] !== "string" || params["id"] === "") {
    return rpcError(res, id, ERROR.invalidParams, "params.id is required (string)");
  }
  const stored = tasks.get(params["id"]);
  if (!stored) return rpcError(res, id, ERROR.taskNotFound, "Task not found");
  if (!authorize(req, res, stored.role, "A2A GetTask")) return;
  // Someone else's task looks the same as one that does not exist.
  if (stored.owner !== callerIdentity(req)) {
    return rpcError(res, id, ERROR.taskNotFound, "Task not found");
  }
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id,
    result: trimHistory(stored.task, params["historyLength"]),
  });
}

/** `POST /a2a`: the JSON-RPC endpoint the Agent Card's `supportedInterfaces` points at. */
export async function handleA2aRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: Partial<ApiDeps> = {},
): Promise<void> {
  // Anyone who reaches the endpoint must hold a valid token; the operation's own role is checked
  // once the request says which operation it wants.
  if (!authorize(req, res, "reader", "POST /a2a")) return;

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      return rpcError(res, null, ERROR.parse, "Invalid JSON body");
    }
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      if (error.status === 413) res.once("finish", () => req.destroy());
      return;
    }
    return rpcError(res, null, ERROR.parse, "Invalid JSON body");
  }

  if (!isRecord(body) || body["jsonrpc"] !== "2.0" || typeof body["method"] !== "string") {
    return rpcError(res, null, ERROR.invalidRequest, "Not a JSON-RPC 2.0 request");
  }
  const id = body["id"];
  if (typeof id !== "string" && typeof id !== "number") {
    return rpcError(res, null, ERROR.invalidRequest, "id is required (string or number)");
  }
  if (!requestedVersionIsSupported(req)) {
    return rpcError(
      res,
      id,
      ERROR.versionNotSupported,
      `Only A2A-Version ${A2A_PROTOCOL_VERSION} is supported`,
    );
  }
  const params = body["params"] ?? {};
  if (!isRecord(params)) return rpcError(res, id, ERROR.invalidParams, "params must be an object");

  switch (body["method"]) {
    case "SendMessage": {
      const operations = new Map(
        a2aSkillOperations().map((operation) => [operation.name, operation]),
      );
      return sendMessage(req, res, id, params, deps, operations);
    }
    case "GetTask": {
      return getTask(req, res, id, params);
    }
    default: {
      return rpcError(
        res,
        id,
        ERROR.methodNotFound,
        `Method not supported: ${body["method"]}. Supported: SendMessage, GetTask`,
      );
    }
  }
}
