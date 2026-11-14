export { HttpError, readBody, sendJson } from "../platform/http-security.js";

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

