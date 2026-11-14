import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRbacAuthorization } from "./rbac.js";

function call(routeKey: string, headers: Record<string, string> = {}) {
  const req = { headers } as unknown as http.IncomingMessage;
  const sent: { status?: number; body?: string } = {};
  const res = {
    headersSent: false,
    writeHead: (status: number) => {
      sent.status = status;
    },
    end: (body: string) => {
      sent.body = body;
    },
  } as unknown as http.ServerResponse;
  return { allowed: checkRbacAuthorization(req, res, routeKey), sent };
}

describe("HTTP server authentication requirement", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses mutating routes when no authentication is configured", () => {
    vi.stubEnv("AUTOREMEDIATOR_API_TOKENS", "");
    vi.stubEnv("AUTOREMEDIATOR_JWT_SECRET", "");
    vi.stubEnv("AUTOREMEDIATOR_INSECURE_NO_AUTH", "");
    const { allowed, sent } = call("POST /remediate");
    expect(allowed).toBe(false);
    expect(sent.status).toBe(503);
    expect(sent.body).toContain("AUTOREMEDIATOR_INSECURE_NO_AUTH");
  });

  it("allows unauthenticated access only with the explicit opt-out", () => {
    vi.stubEnv("AUTOREMEDIATOR_API_TOKENS", "");
    vi.stubEnv("AUTOREMEDIATOR_JWT_SECRET", "");
    vi.stubEnv("AUTOREMEDIATOR_INSECURE_NO_AUTH", "1");
    expect(call("POST /remediate").allowed).toBe(true);
  });

  it("keeps health and spec public", () => {
    vi.stubEnv("AUTOREMEDIATOR_API_TOKENS", "");
    vi.stubEnv("AUTOREMEDIATOR_JWT_SECRET", "");
    vi.stubEnv("AUTOREMEDIATOR_INSECURE_NO_AUTH", "");
    expect(call("GET /health").allowed).toBe(true);
    expect(call("GET /openapi.json").allowed).toBe(true);
  });

  it("requires a valid bearer token once tokens are configured", () => {
    vi.stubEnv("AUTOREMEDIATOR_API_TOKENS", "admin:s3cret");
    expect(call("POST /remediate").sent.status).toBe(401);
    expect(call("POST /remediate", { authorization: "Bearer wrong" }).allowed).toBe(false);
    expect(call("POST /remediate", { authorization: "Bearer s3cret" }).allowed).toBe(true);
  });
});
