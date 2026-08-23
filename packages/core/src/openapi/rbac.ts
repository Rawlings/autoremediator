import { createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { sendJson } from "./http-utils.js";

export type Role = "admin" | "operator" | "reader";

const ROLE_HIERARCHY: Record<Role, number> = {
  reader: 1,
  operator: 2,
  admin: 3,
};

const ROUTE_ROLE_REQUIREMENTS: Record<string, Role> = {
  "GET /health": "reader",
  "GET /openapi.json": "reader",
  "GET /jobs": "reader",
  "POST /vex": "reader",
  "POST /patches/list": "reader",
  "POST /patches/inspect": "reader",
  "POST /patches/validate": "reader",
  "POST /plan-remediation": "operator",
  "POST /jobs/remediate": "operator",
  "POST /jobs/scan": "operator",
  "POST /jobs/portfolio": "operator",
  "POST /remediate": "admin",
  "POST /remediate-from-scan": "admin",
  "POST /remediate-portfolio": "admin",
  "POST /update-outdated": "admin",
};

export interface JwtPayload {
  sub?: string;
  role?: Role | string;
  roles?: Array<Role | string>;
  scope?: string;
  exp?: number;
  [key: string]: unknown;
}

/**
 * Creates an HMAC-SHA256 signed JWT string for testing or token issuance.
 */
export function createSignedJwt(payload: JwtPayload, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed JWT and extracts the role.
 */
export function verifyJwtRole(token: string, secret: string): Role | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  const [headerB64, bodyB64, signatureB64] = parts as [string, string, string];

  try {
    const expectedSig = createHmac("sha256", secret)
      .update(`${headerB64}.${bodyB64}`)
      .digest("base64url");
    const sigBuf = Buffer.from(signatureB64);
    const expBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return undefined;
    }

    const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8")) as JwtPayload;

    if (typeof payload.exp === "number") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= payload.exp) {
        return undefined; // Expired
      }
    }

    // Role resolution from claims
    const possibleRoles: string[] = [];
    if (typeof payload.role === "string") possibleRoles.push(payload.role);
    if (Array.isArray(payload.roles))
      possibleRoles.push(...payload.roles.filter((r): r is string => typeof r === "string"));
    if (typeof payload.scope === "string") possibleRoles.push(...payload.scope.split(" "));

    if (possibleRoles.includes("admin")) return "admin";
    if (possibleRoles.includes("operator")) return "operator";
    if (possibleRoles.includes("reader")) return "reader";
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Parses configured tokens from environment or explicit map (JWT or static pre-shared key).
 */
export function getRoleForToken(
  token: string,
  envTokens = process.env.AUTOREMEDIATOR_API_TOKENS,
  jwtSecret = process.env.AUTOREMEDIATOR_JWT_SECRET,
): Role | undefined {
  // 1. Try JWT verification if secret is configured
  if (jwtSecret && token.includes(".")) {
    const jwtRole = verifyJwtRole(token, jwtSecret);
    if (jwtRole) return jwtRole;
  }

  // 2. Try static pre-shared key lookup
  if (envTokens) {
    const pairs = envTokens
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pair of pairs) {
      const [role, secret] = pair.split(":");
      if (
        secret &&
        secret === token &&
        (role === "admin" || role === "operator" || role === "reader")
      ) {
        return role as Role;
      }
    }
  }

  if (!envTokens && !jwtSecret) {
    return "admin"; // Default dev mode
  }

  return undefined;
}

/**
 * Verifies if the request is authorized for the given route based on Bearer token.
 */
export function checkRbacAuthorization(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routeKey: string,
): boolean {
  if (!process.env.AUTOREMEDIATOR_API_TOKENS && !process.env.AUTOREMEDIATOR_JWT_SECRET) {
    return true;
  }

  // Public health and spec endpoints don't require auth
  if (routeKey === "GET /health" || routeKey === "GET /openapi.json") {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "Unauthorized: Missing or invalid Bearer token" });
    return false;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const userRole = getRoleForToken(token);

  if (!userRole) {
    sendJson(res, 401, { error: "Unauthorized: Invalid or expired API token" });
    return false;
  }

  const requiredRole = ROUTE_ROLE_REQUIREMENTS[routeKey] ?? "admin";
  if (ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[requiredRole]) {
    sendJson(res, 403, {
      error: `Forbidden: Role '${userRole}' has insufficient permissions for ${routeKey} (requires '${requiredRole}')`,
    });
    return false;
  }

  return true;
}
