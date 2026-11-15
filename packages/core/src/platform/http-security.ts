import type http from "node:http";

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

/**
 * The text of an error that is safe to hand to an HTTP caller: the first line of its message,
 * capped in length. Never a stack trace, never the object's own string form (which can carry one).
 */
export function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Request failed";
  const [firstLine = ""] = message.split(/\r?\n/, 1);
  const trimmed = firstLine.trim().slice(0, 500);
  return trimmed === "" ? "Request failed" : trimmed;
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

/**
 * Whether the request's Host header names this machine: the loopback names, plus any in
 * `AUTOREMEDIATOR_ALLOWED_HOSTS`. Rejecting anything else stops a DNS-rebinding page from
 * reaching a server that listens on loopback.
 */
export function isHostAllowed(req: http.IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env["AUTOREMEDIATOR_ALLOWED_HOSTS"]
    ?.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowed =
    configured && configured.length > 0 ? configured : ["127.0.0.1", "localhost", "[::1]"];
  const host = (req.headers.host ?? "").toLowerCase();
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  return allowed.includes(name);
}
