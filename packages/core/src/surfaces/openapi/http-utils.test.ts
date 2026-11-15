import type http from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError, readBody } from "./http-utils.js";

function fakeRequest(
  body: string | undefined,
  headers: Record<string, string>,
): http.IncomingMessage {
  const stream = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  stream.headers = headers;
  if (body !== undefined) (stream as unknown as Readable).push(body);
  (stream as unknown as Readable).push(null);
  return stream;
}

describe("readBody", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses application/json bodies, with or without a charset", async () => {
    await expect(
      readBody(fakeRequest('{"a":1}', { "content-type": "application/json" })),
    ).resolves.toEqual({ a: 1 });
    await expect(
      readBody(fakeRequest('{"a":1}', { "content-type": "application/json; charset=utf-8" })),
    ).resolves.toEqual({ a: 1 });
  });

  it("treats an empty JSON request as an empty object", async () => {
    await expect(
      readBody(fakeRequest(undefined, { "content-type": "application/json" })),
    ).resolves.toEqual({});
  });

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "application/jsonp"])(
    "rejects content-type %s with 415 (blocks cross-site simple requests)",
    async (contentType) => {
      const headers: Record<string, string> = contentType ? { "content-type": contentType } : {};
      await expect(readBody(fakeRequest("{}", headers))).rejects.toMatchObject({
        name: "HttpError",
        status: 415,
      });
    },
  );

  it("rejects malformed JSON with 400", async () => {
    await expect(
      readBody(fakeRequest("{nope", { "content-type": "application/json" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects bodies over the configured limit with 413 (streamed)", async () => {
    vi.stubEnv("AUTOREMEDIATOR_MAX_BODY_BYTES", "64");
    const big = JSON.stringify({ pad: "x".repeat(500) });
    const err = await readBody(fakeRequest(big, { "content-type": "application/json" })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });

  it("rejects an oversized declared content-length before reading", async () => {
    vi.stubEnv("AUTOREMEDIATOR_MAX_BODY_BYTES", "64");
    await expect(
      readBody(fakeRequest("{}", { "content-type": "application/json", "content-length": "9999" })),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("accepts bodies up to the default 1 MiB", async () => {
    const body = JSON.stringify({ pad: "x".repeat(200_000) });
    await expect(
      readBody(fakeRequest(body, { "content-type": "application/json" })),
    ).resolves.toMatchObject({ pad: expect.any(String) });
  });
});
