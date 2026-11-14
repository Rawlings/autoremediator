import http from "node:http";
import { stripUntrustedChangeRequestFields } from "../api/change-request/index.js";

const DEFAULT_PORT = 3000;

export function parsePort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) {
    const p = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(p)) return p;
  }
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (!isNaN(p)) return p;
  }
  return DEFAULT_PORT;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function getMaxBodyBytes(): number {
  const parsed = Number.parseInt(process.env.AUTOREMEDIATOR_MAX_BODY_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES;
}

/**
 * Read and parse a JSON request body.
 *
 * Requires `Content-Type: application/json`: a browser cannot send that cross-origin without a
 * CORS preflight (which this server never grants), so it blocks drive-by form/text POSTs.
 */
export function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] ?? "");
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      reject(new HttpError(415, "Content-Type must be application/json"));
      return;
    }

    const limit = getMaxBodyBytes();
    const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, `Request body exceeds ${limit} bytes`));
      return;
    }

    let raw = "";
    let received = 0;
    let failed = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (failed) return;
      received += Buffer.byteLength(chunk);
      if (received > limit) {
        failed = true;
        raw = "";
        reject(new HttpError(413, `Request body exceeds ${limit} bytes`));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (failed) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function withOpenApiSource(options: unknown): Record<string, unknown> {
  const normalized =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  return {
    ...stripUntrustedChangeRequestFields(normalized),
    source: typeof normalized.source === "string" ? normalized.source : "openapi",
  };
}
