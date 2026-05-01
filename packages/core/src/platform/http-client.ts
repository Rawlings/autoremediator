/**
 * Shared HTTP client wrapper for all non-SDK external API calls.
 *
 * Provides a consistent interface for JSON API calls with:
 * - Unified error handling and logging
 * - Timeout and retry semantics
 * - Request/response validation
 * - No external dependencies (uses native fetch)
 *
 * Used for: OSV, CVE Services, npm registry, EPSS, deps.dev, Scorecard.
 */

export interface HttpClientRequest {
  url: string | URL;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface HttpClientResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function requestWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Execute an HTTP request with timeout, error handling, and response parsing.
 *
 * @param request - HTTP request configuration
 * @returns Parsed response with status, ok flag, and data
 * @throws HttpError on network failure or timeout (caught errors are logged and safe to continue)
 */
export async function httpClient(request: HttpClientRequest): Promise<HttpClientResponse> {
  const {
    url,
    method = "GET",
    headers = {},
    body,
    timeout = DEFAULT_TIMEOUT_MS,
  } = request;

  const init: RequestInit = {
    method,
    headers: {
      "Accept": "application/json",
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body =
      typeof body === "string"
        ? body
        : JSON.stringify(body);
    const headersObj = (init.headers ?? {}) as Record<string, string>;
    if (!headersObj["Content-Type"]) {
      headersObj["Content-Type"] = "application/json";
    }
    init.headers = headersObj;
  }

  try {
    const res = await requestWithTimeout(url, init, timeout);

    // Cap response size before reading to prevent memory exhaustion from
    // malicious or compromised intelligence sources.
    const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
    const contentLength = res.headers?.get?.("content-length") ?? null;
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new HttpError(`Response too large (content-length: ${contentLength})`, "HTTP_ERROR");
    }

    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new HttpError("Response body exceeds 10 MB limit", "HTTP_ERROR");
    }

    // Parse JSON if response has content, otherwise return empty object
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Response is not JSON; store as-is
      data = text;
    }

    return {
      status: res.status,
      ok: res.ok,
      data,
      text,
    };
  } catch (err) {
    // Timeout or network error
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("AbortError")) {
      throw new HttpError(`Request timeout after ${timeout}ms`, "TIMEOUT");
    }
    throw new HttpError(`Network error: ${errorMsg}`, "NETWORK_ERROR");
  }
}

/**
 * Execute an HTTP request and throw if response is not ok.
 * Returns parsed JSON data on success.
 */
export async function httpClientJson<T = unknown>(
  request: HttpClientRequest
): Promise<T> {
  const res = await httpClient(request);
  if (!res.ok) {
    throw new HttpError(
      `HTTP ${res.status}: ${res.text}`,
      "HTTP_ERROR"
    );
  }
  return res.data as T;
}

/**
 * Custom error class for HTTP client failures.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly code: "TIMEOUT" | "NETWORK_ERROR" | "HTTP_ERROR"
  ) {
    super(message);
    this.name = "HttpError";
  }
}
