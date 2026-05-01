import { createAppAuth } from "@octokit/auth-app";
import type { InstallationToken } from "./types.js";

interface InstallationTokenProvider {
  getInstallationToken(installationId: number): Promise<InstallationToken>;
}

interface CreateInstallationTokenProviderOptions {
  appId: string;
  privateKey: string;
  cacheSkewMs?: number;
}

interface CachedInstallationToken {
  token: string;
  expiresAtEpochMs?: number;
}

function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
  if (!normalized.includes("-----BEGIN") || !normalized.includes("-----END")) {
    throw new Error("GitHub App private key does not appear to be valid PEM format");
  }
  return normalized;
}

function parseExpiresAtEpochMs(expiresAt: string | undefined): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createInstallationTokenProvider(
  options: CreateInstallationTokenProviderOptions
): InstallationTokenProvider {
  const auth = createAppAuth({
    appId: options.appId,
    privateKey: normalizePrivateKey(options.privateKey),
  });

  const cacheSkewMs = options.cacheSkewMs ?? 60_000;
  const tokenCache = new Map<number, CachedInstallationToken>();

  return {
    async getInstallationToken(installationId: number): Promise<InstallationToken> {
      const now = Date.now();
      const cached = tokenCache.get(installationId);
      if (cached && (cached.expiresAtEpochMs === undefined || cached.expiresAtEpochMs > now + cacheSkewMs)) {
        return {
          token: cached.token,
          expiresAt: cached.expiresAtEpochMs ? new Date(cached.expiresAtEpochMs).toISOString() : undefined,
        };
      }

      const authResult = (await auth({
        type: "installation",
        installationId,
      })) as { token: string; expiresAt?: string };

      const nextCached: CachedInstallationToken = {
        token: authResult.token,
        expiresAtEpochMs: parseExpiresAtEpochMs(authResult.expiresAt),
      };
      tokenCache.set(installationId, nextCached);

      return {
        token: authResult.token,
        expiresAt: authResult.expiresAt,
      };
    },
  };
}

export type { InstallationTokenProvider };
