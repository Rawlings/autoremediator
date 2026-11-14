import type http from "node:http";

const DEFAULT_PORT = 3000;

export function parsePort(): number {
  const idx = process.argv.indexOf("--port");
  const rawPort = process.argv[idx + 1];
  if (idx !== -1 && rawPort) {
    const p = Number.parseInt(rawPort, 10);
    if (!Number.isNaN(p)) return p;
  }
  if (process.env.PORT) {
    const p = Number.parseInt(process.env.PORT, 10);
    if (!Number.isNaN(p)) return p;
  }
  return DEFAULT_PORT;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    const contentType = req.headers["content-type"] ?? "";
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      reject(new HttpError(415, "Content-Type must be application/json"));
      return;
    }

    const limit = getMaxBodyBytes();
    const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
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
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
        return;
      }
      resolve(parsed);
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
