import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";

import { sha256 } from "../../shared/hash.js";

export type Role = "admin" | "operator" | "reader";

const ROLE_HIERARCHY: Record<Role, number> = {
  reader: 1,
  operator: 2,
  admin: 3,
};

export interface JwtPayload {
  sub?: string;
  role?: Role | (string & {});
  roles?: Array<Role | (string & {})>;
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

/** Compares two secrets in constant time (over digests, so their lengths do not show either). */
const sha256Digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256Digest(a), sha256Digest(b));
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
      // Split at the first colon only: a secret may itself contain one.
      const colon = pair.indexOf(":");
      const role = colon === -1 ? "" : pair.slice(0, colon);
      const secret = colon === -1 ? "" : pair.slice(colon + 1);
      if (
        secret &&
        sameSecret(secret, token) &&
        (role === "admin" || role === "operator" || role === "reader")
      ) {
        return role;
      }
    }
  }

  if (!envTokens && !jwtSecret) {
    return "admin"; // Default dev mode
  }

  return undefined;
}

/**
 * Who a request comes from, for binding stored results to their caller: the `sub` of a verified JWT
 * (so a refreshed token is the same caller), otherwise a digest of the bearer token. Never the token
 * itself. Requests without a token (only possible with authentication switched off) share one identity.
 */
export function callerIdentity(
  req: http.IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  if (!token) return "anonymous";
  const secret = env["AUTOREMEDIATOR_JWT_SECRET"];
  if (secret && token.includes(".") && verifyJwtRole(token, secret)) {
    try {
      const body = token.split(".")[1] ?? "";
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JwtPayload;
      if (typeof payload.sub === "string" && payload.sub !== "") {
        return `sub:${sha256(payload.sub)}`;
      }
    } catch {
      // Verified a moment ago, so this cannot normally happen; fall back to the token digest.
    }
  }
  return `token:${sha256(token)}`;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export type AuthDecision = { ok: true } | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Whether a request may use something that needs `requiredRole`, from its Bearer token. With no
 * tokens or JWT secret configured every request is refused, unless
 * `AUTOREMEDIATOR_INSECURE_NO_AUTH` is set (local development only).
 */
export function authorizeRole(
  req: http.IncomingMessage,
  requiredRole: Role,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthDecision {
  if (!env["AUTOREMEDIATOR_API_TOKENS"] && !env["AUTOREMEDIATOR_JWT_SECRET"]) {
    // Anything served can mutate the filesystem, so unauthenticated access is opt-in only.
    if (isTruthy(env["AUTOREMEDIATOR_INSECURE_NO_AUTH"])) return { ok: true };
    return {
      ok: false,
      status: 503,
      error:
        "Authentication is not configured. Set AUTOREMEDIATOR_API_TOKENS or AUTOREMEDIATOR_JWT_SECRET, " +
        "or set AUTOREMEDIATOR_INSECURE_NO_AUTH=1 to explicitly run without authentication (local development only).",
    };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Unauthorized: Missing or invalid Bearer token" };
  }

  const userRole = getRoleForToken(authHeader.slice("Bearer ".length).trim());
  if (!userRole)
    return { ok: false, status: 401, error: "Unauthorized: Invalid or expired API token" };

  if (ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[requiredRole]) {
    return {
      ok: false,
      status: 403,
      error: `Forbidden: Role '${userRole}' has insufficient permissions for ${label} (requires '${requiredRole}')`,
    };
  }
  return { ok: true };
}
