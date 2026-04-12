import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => authMock),
}));

describe("createInstallationTokenProvider", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("caches installation token until close to expiry", async () => {
    const now = Date.now();
    authMock.mockResolvedValue({
      token: "token-1",
      expiresAt: new Date(now + 120_000).toISOString(),
    });

    const { createInstallationTokenProvider } = await import("./auth.js");
    const provider = createInstallationTokenProvider({
      appId: "123",
      privateKey: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    });

    const first = await provider.getInstallationToken(101);
    const second = await provider.getInstallationToken(101);

    expect(first.token).toBe("token-1");
    expect(second.token).toBe("token-1");
    expect(authMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes token when cached token is near expiry", async () => {
    const now = Date.now();
    authMock
      .mockResolvedValueOnce({
        token: "token-old",
        expiresAt: new Date(now + 10_000).toISOString(),
      })
      .mockResolvedValueOnce({
        token: "token-new",
        expiresAt: new Date(now + 120_000).toISOString(),
      });

    const { createInstallationTokenProvider } = await import("./auth.js");
    const provider = createInstallationTokenProvider({
      appId: "123",
      privateKey: "key",
    });

    const first = await provider.getInstallationToken(102);
    const second = await provider.getInstallationToken(102);

    expect(first.token).toBe("token-old");
    expect(second.token).toBe("token-new");
    expect(authMock).toHaveBeenCalledTimes(2);
  });
});
