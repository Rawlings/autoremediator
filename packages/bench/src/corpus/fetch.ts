/**
 * The only network access the benchmark's curation tools have: public, read-only GETs to the npm
 * registry and OSV. Anything else is refused before a request is made. Nothing about the user or
 * their projects is ever sent: the only headers are a generic user agent and an accept type.
 */
const ALLOWED_HOSTS = new Set(["registry.npmjs.org", "api.osv.dev"]);

export const MAX_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_TARBALL_BYTES = 32 * 1024 * 1024;

export type FetchBytes = (url: string, options: { maxBytes: number }) => Promise<Buffer>;

export function assertAllowedUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing to fetch ${parsed.origin}: curation may only read ${[...ALLOWED_HOSTS].join(" and ")} over https`,
    );
  }
  return parsed;
}

export const fetchBytes: FetchBytes = async (url, { maxBytes }) => {
  const parsed = assertAllowedUrl(url);
  const response = await fetch(parsed, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    headers: { accept: "application/json", "user-agent": "benchmark-corpus-fetch" },
  });
  if (!response.ok) throw new Error(`GET ${parsed.href} failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`GET ${parsed.href}: ${declared} bytes exceeds ${maxBytes}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) {
    throw new Error(`GET ${parsed.href}: ${body.length} bytes exceeds ${maxBytes}`);
  }
  return body;
};

export async function fetchJson(get: FetchBytes, url: string): Promise<unknown> {
  return JSON.parse((await get(url, { maxBytes: MAX_JSON_BYTES })).toString("utf8")) as unknown;
}

/** `@scope/name` is requested as `@scope%2Fname`. */
export function registryUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
}

export function osvUrl(id: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`Not an advisory id: ${id}`);
  return `https://api.osv.dev/v1/vulns/${id}`;
}
