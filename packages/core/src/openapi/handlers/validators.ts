import http from "node:http";
import { readBody, sendJson } from "../http-utils.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readJsonBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<T | undefined> {
  try {
    return (await readBody(req)) as T;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return undefined;
  }
}

export async function runRequest<T>(
  res: http.ServerResponse,
  action: () => Promise<T>
): Promise<void> {
  try {
    const report = await action();
    sendJson(res, 200, report);
  } catch (error) {
    sendJson(res, 400, { error: toMessage(error) });
  }
}

export function requireStringField(
  body: Record<string, unknown> | undefined,
  field: string,
  res: http.ServerResponse,
  errorMessage: string
): string | undefined {
  if (!body || typeof body[field] !== "string" || !(body[field] as string)) {
    sendJson(res, 400, { error: errorMessage });
    return undefined;
  }
  return body[field] as string;
}