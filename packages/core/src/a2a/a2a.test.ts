import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultApiDeps, OPERATIONS, roleFor, type ApiDeps } from "../catalog/index.js";
import { createOpenApiServer } from "../openapi/server.js";
import { createSignedJwt } from "../platform/http-auth.js";
import {
  A2A_ENDPOINT_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_SKILL_NAMES,
  AGENT_CARD_PATH,
  a2aSkillOperations,
  buildAgentCard,
  type AgentCard,
} from "./index.js";
import { canonicalize, signAgentCard, signingKeyFromPem, verifyAgentCard } from "./sign.js";

type Json = any;
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

const privatePem = (key: KeyObject) => key.export({ format: "pem", type: "pkcs8" });

describe("buildAgentCard", () => {
  const card = buildAgentCard({ baseUrl: "https://agent.example.com/", version: "9.9.9" });

  it("has every field A2A 1.0 requires on an AgentCard", () => {
    for (const field of [
      "name",
      "description",
      "supportedInterfaces",
      "version",
      "capabilities",
      "defaultInputModes",
      "defaultOutputModes",
      "skills",
    ]) {
      expect(card).toHaveProperty(field);
    }
    expect(card.version).toBe("9.9.9");
    expect(card.supportedInterfaces).toEqual([
      {
        url: "https://agent.example.com/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ]);
    expect(card.defaultInputModes).toEqual(["application/json"]);
    expect(card.defaultOutputModes).toEqual(["application/json"]);
  });

  it("only defines members the specification defines", () => {
    const allowed = new Set([
      "name",
      "description",
      "supportedInterfaces",
      "provider",
      "version",
      "documentationUrl",
      "capabilities",
      "securitySchemes",
      "securityRequirements",
      "defaultInputModes",
      "defaultOutputModes",
      "skills",
      "signatures",
      "iconUrl",
    ]);
    expect(Object.keys(card).filter((key) => !allowed.has(key))).toEqual([]);
    const skillFields = new Set([
      "id",
      "name",
      "description",
      "tags",
      "examples",
      "inputModes",
      "outputModes",
      "securityRequirements",
    ]);
    for (const skill of card.skills) {
      expect(Object.keys(skill).filter((key) => !skillFields.has(key))).toEqual([]);
    }
  });

  it("does not advertise capabilities it lacks", () => {
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    });
  });

  it("declares the HTTP server's bearer authentication", () => {
    expect(card.securitySchemes["bearerAuth"]).toEqual({
      httpAuthSecurityScheme: expect.objectContaining({ scheme: "Bearer", bearerFormat: "JWT" }),
    });
    expect(card.securityRequirements).toEqual([{ schemes: { bearerAuth: { list: [] } } }]);
  });

  it("builds skills from catalog operations only", () => {
    const catalog = new Map(OPERATIONS.map((operation) => [operation.name, operation]));
    expect(card.skills.map((skill) => skill.id)).toEqual([...A2A_SKILL_NAMES]);
    for (const skill of card.skills) {
      const operation = catalog.get(skill.id);
      expect(operation).toBeDefined();
      expect(skill.name).toBe(operation?.title);
      expect(skill.description).toContain(operation?.description);
      expect(skill.description).toContain(`"${roleFor(operation!)}" role`);
      expect(skill.tags.length).toBeGreaterThan(0);
      expect(skill.inputModes).toEqual(["application/json"]);
      expect(skill.outputModes).toEqual(["application/json"]);
    }
    expect(new Set(card.skills.map((skill) => skill.id)).size).toBe(card.skills.length);
    expect(card.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining(["remediate", "guardPackage", "scanDelta", "verifyRun"]),
    );
  });

  it("is pure and takes the skills it is given", () => {
    const again = buildAgentCard({ baseUrl: "https://agent.example.com", version: "9.9.9" });
    expect(again).toEqual(card);
    const [first] = a2aSkillOperations();
    const small = buildAgentCard({
      baseUrl: "https://agent.example.com",
      version: "1.0.0",
      skills: [first!],
    });
    expect(small.skills).toHaveLength(1);
  });

  it("rejects a base URL that is not http(s)", () => {
    expect(() => buildAgentCard({ baseUrl: "ftp://x", version: "1" })).toThrow(/http/);
    expect(() => buildAgentCard({ baseUrl: "nope", version: "1" })).toThrow(/Invalid/);
  });
});

describe("card signing", () => {
  const card = buildAgentCard({ baseUrl: "https://agent.example.com", version: "1.2.3" });

  it("canonicalizes per RFC 8785", () => {
    expect(canonicalize({ b: [1, { z: null, a: true }], a: "x\n", u: undefined })).toBe(
      String.raw`{"a":"x\n","b":[1,{"a":true,"z":null}]}`,
    );
    expect(canonicalize({ é: 1, e: 2, "😀": 3 })).toBe('{"e":2,"é":1,"😀":3}');
  });

  it.each([
    ["ES256", () => generateKeyPairSync("ec", { namedCurve: "P-256" }), "sha256"],
    ["ES384", () => generateKeyPairSync("ec", { namedCurve: "P-384" }), "sha384"],
    ["EdDSA", () => generateKeyPairSync("ed25519"), null],
  ] as const)("%s signature verifies with the public key", (alg, generate, hash) => {
    const { privateKey, publicKey } = generate();
    const signed = signAgentCard(card, signingKeyFromPem(privatePem(privateKey)));

    expect(signed.signatures).toHaveLength(1);
    const [entry] = signed.signatures!;
    expect(Object.keys(entry!).toSorted()).toEqual(["protected", "signature"]);

    const header = JSON.parse(Buffer.from(entry!.protected, "base64url").toString("utf8"));
    const jwk = publicKey.export({ format: "jwk" });
    const members =
      jwk.kty === "EC"
        ? `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
        : `{"crv":"${jwk.crv}","kty":"OKP","x":"${jwk.x}"}`;
    expect(header).toEqual({
      alg,
      typ: "JOSE",
      kid: createHash("sha256").update(members).digest("base64url"),
    });

    // Independent check with node:crypto: JWS signing input over the JCS of the card sans signatures.
    const { signatures: _omit, ...unsigned } = signed;
    const payload = Buffer.from(canonicalize(unsigned)).toString("base64url");
    const input = Buffer.from(`${entry!.protected}.${payload}`, "ascii");
    const signature = Buffer.from(entry!.signature, "base64url");
    const valid =
      hash === null
        ? verify(null, input, publicKey, signature)
        : verify(hash, input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    expect(valid).toBe(true);

    expect(verifyAgentCard(signed, publicKey)).toBe(true);
    expect(verifyAgentCard({ ...signed, version: "tampered" }, publicKey)).toBe(false);
    const other = generateKeyPairSync("ed25519").publicKey;
    expect(verifyAgentCard(signed, other)).toBe(false);
  });

  it("leaves the private key out of the signed card", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privatePem(privateKey);
    const signed = signAgentCard(card, signingKeyFromPem(pem));
    const body = JSON.stringify(signed);
    expect(body).not.toContain("PRIVATE KEY");
    expect(body).not.toContain(pem.replaceAll(/-----[^-]+-----|\s/g, ""));
  });

  it("refuses a key type it cannot sign with", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => signingKeyFromPem(privatePem(privateKey))).toThrow(/EC key/);
  });
});

describe("HTTP server", () => {
  let dir: string;
  let server: ReturnType<typeof createOpenApiServer>;
  let origin: string;
  let guardPackageFn: ReturnType<typeof vi.fn>;
  let remediateFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "a2a-")));
    vi.stubEnv("AUTOREMEDIATOR_ALLOWED_ROOTS", dir);
    vi.stubEnv("AUTOREMEDIATOR_API_TOKENS", "admin:adm-SECRET,reader:rdr-SECRET");
    vi.stubEnv("AUTOREMEDIATOR_JWT_SECRET", "jwt-SECRET-value");
    vi.stubEnv("AUTOREMEDIATOR_A2A_SIGNING_KEY", "");
    vi.stubEnv("AUTOREMEDIATOR_A2A_BASE_URL", "");
    guardPackageFn = vi.fn(async (spec: string) => ({ spec, verdict: "allow" }));
    remediateFn = vi.fn(async (cveId: string) => ({ cveId, status: "done" }));
    const deps = { ...defaultApiDeps, guardPackageFn, remediateFn } as unknown as ApiDeps;
    server = createOpenApiServer(deps);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => {
      server.close(resolve);
    });
    rmSync(dir, { recursive: true, force: true });
  });

  const rpc = (
    method: string,
    params: unknown,
    headers: Record<string, string> = {},
    id: number | string = 1,
  ) =>
    fetch(`${origin}${A2A_ENDPOINT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  const asReader = { Authorization: "Bearer rdr-SECRET" };
  const asAdmin = { Authorization: "Bearer adm-SECRET" };
  const invoke = (operation: string, input: unknown, extra: object = {}) => ({
    message: {
      messageId: "m1",
      role: "ROLE_USER",
      parts: [{ data: { operation, input }, mediaType: "application/json" }],
    },
    ...extra,
  });

  describe("GET /.well-known/agent-card.json", () => {
    it("is served without authentication, matching the built card", async () => {
      const res = await fetch(`${origin}${AGENT_CARD_PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const served = (await res.json()) as AgentCard;
      expect(served.supportedInterfaces[0]?.url).toBe(`${origin}/a2a`);
      expect(served.skills.map((skill) => skill.id)).toEqual([...A2A_SKILL_NAMES]);
      expect(served.signatures).toBeUndefined();
    });

    it("never contains tokens, the JWT secret or key material", async () => {
      const { privateKey } = generateKeyPairSync("ed25519");
      const keyPath = join(dir, "card.pem");
      writeFileSync(keyPath, privatePem(privateKey));
      vi.stubEnv("AUTOREMEDIATOR_A2A_SIGNING_KEY", keyPath);
      const body = await (await fetch(`${origin}${AGENT_CARD_PATH}`)).text();
      for (const secret of [
        "adm-SECRET",
        "rdr-SECRET",
        "jwt-SECRET-value",
        "PRIVATE KEY",
        keyPath,
      ]) {
        expect(body).not.toContain(secret);
      }
    });

    it("is signed when AUTOREMEDIATOR_A2A_SIGNING_KEY is set, and the signature verifies", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const keyPath = join(dir, "card-ec.pem");
      writeFileSync(keyPath, privatePem(privateKey));
      vi.stubEnv("AUTOREMEDIATOR_A2A_SIGNING_KEY", keyPath);

      const served = (await (await fetch(`${origin}${AGENT_CARD_PATH}`)).json()) as AgentCard;
      expect(served.signatures).toHaveLength(1);
      expect(
        verifyAgentCard(served, createPublicKey(publicKey.export({ format: "pem", type: "spki" }))),
      ).toBe(true);
    });

    it("fails loudly rather than serving an unsigned card when the key is unusable", async () => {
      vi.stubEnv("AUTOREMEDIATOR_A2A_SIGNING_KEY", join(dir, "missing.pem"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await fetch(`${origin}${AGENT_CARD_PATH}`);
      spy.mockRestore();
      expect(res.status).toBe(500);
      await expect(res.text()).resolves.not.toContain("missing.pem");
    });

    it("uses AUTOREMEDIATOR_A2A_BASE_URL when set", async () => {
      vi.stubEnv("AUTOREMEDIATOR_A2A_BASE_URL", "https://agent.example.com/");
      const served = (await (await fetch(`${origin}${AGENT_CARD_PATH}`)).json()) as AgentCard;
      expect(served.supportedInterfaces[0]?.url).toBe("https://agent.example.com/a2a");
    });

    it("does not let a Host header smuggle userinfo into the advertised URL", async () => {
      vi.stubEnv("AUTOREMEDIATOR_ALLOWED_HOSTS", "localhost");
      const served = await new Promise<AgentCard>((resolve, reject) => {
        const req = httpRequest(
          `${origin}${AGENT_CARD_PATH}`,
          { headers: { Host: "localhost:80@evil.example" } },
          (res) => {
            let raw = "";
            res.on("data", (chunk) => (raw += chunk));
            res.on("end", () => resolve(JSON.parse(raw) as AgentCard));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(served.supportedInterfaces[0]?.url).toBe("http://127.0.0.1/a2a");
    });
  });

  describe("POST /a2a", () => {
    it("requires authentication", async () => {
      const res = await rpc("SendMessage", invoke("guardPackage", { spec: "left-pad" }));
      expect(res.status).toBe(401);
    });

    it("runs a skill and returns a completed task with a JSON artifact", async () => {
      const res = await rpc(
        "SendMessage",
        invoke("guardPackage", { spec: "left-pad@1.3.0" }),
        asReader,
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      const task = body.result.task;
      expect(task.status.state).toBe("TASK_STATE_COMPLETED");
      expect(task.id).toEqual(expect.any(String));
      expect(task.contextId).toEqual(expect.any(String));
      expect(task.artifacts[0].name).toBe("guardPackage");
      expect(task.artifacts[0].parts[0]).toEqual({
        data: { spec: "left-pad@1.3.0", verdict: "allow" },
        mediaType: "application/json",
      });
      expect(task.history).toHaveLength(1);
      expect(guardPackageFn).toHaveBeenCalledWith("left-pad@1.3.0", {});
    });

    it("applies the HTTP role for the operation: a reader cannot run remediate", async () => {
      const res = await rpc(
        "SendMessage",
        invoke("remediate", { cveId: "CVE-2021-23337" }),
        asReader,
      );
      expect(res.status).toBe(403);
      expect(remediateFn).not.toHaveBeenCalled();

      const ok = await rpc(
        "SendMessage",
        invoke("remediate", { cveId: "CVE-2021-23337" }),
        asAdmin,
      );
      expect((await json(ok)).result.task.status.state).toBe("TASK_STATE_COMPLETED");
      expect(remediateFn).toHaveBeenCalledTimes(1);
    });

    it("confines path arguments to the allowed roots", async () => {
      const res = await rpc(
        "SendMessage",
        invoke("guardPackage", { spec: "left-pad", cwd: "/etc" }),
        asReader,
      );
      expect(res.status).toBe(403);
      expect(guardPackageFn).not.toHaveBeenCalled();
    });

    it("refuses operations that are not skills", async () => {
      const body = await json(
        await rpc("SendMessage", invoke("rollbackRun", { runId: "r" }), asAdmin),
      );
      expect(body.error.code).toBe(-32_602);
      expect(body.error.message).toContain("Unknown operation");
    });

    it("rejects invalid input, a missing data part and a continued task", async () => {
      const invalid = await json(await rpc("SendMessage", invoke("guardPackage", {}), asReader));
      expect(invalid.error.code).toBe(-32_602);

      const text = await json(
        await rpc(
          "SendMessage",
          { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "scan my repo" }] } },
          asReader,
        ),
      );
      expect(text.error.code).toBe(-32_602);

      const continued = await json(
        await rpc(
          "SendMessage",
          {
            message: {
              messageId: "m",
              taskId: "t",
              role: "ROLE_USER",
              parts: [{ data: { operation: "guardPackage", input: { spec: "x" } } }],
            },
          },
          asReader,
        ),
      );
      expect(continued.error.code).toBe(-32_004);
    });

    it("answers a failing operation with a failed task, not a transport error", async () => {
      guardPackageFn.mockRejectedValueOnce(new Error("registry unreachable"));
      const body = await json(
        await rpc("SendMessage", invoke("guardPackage", { spec: "x" }), asReader),
      );
      expect(body.result.task.status.state).toBe("TASK_STATE_FAILED");
      expect(body.result.task.status.message.parts[0].text).toBe("registry unreachable");
      expect(body.result.task.artifacts).toBeUndefined();
    });

    it("refuses an output type it does not produce", async () => {
      const body = await json(
        await rpc(
          "SendMessage",
          invoke(
            "guardPackage",
            { spec: "x" },
            { configuration: { acceptedOutputModes: ["image/png"] } },
          ),
          asReader,
        ),
      );
      expect(body.error.code).toBe(-32_005);
    });

    it("rejects other protocol versions, unknown methods and malformed envelopes", async () => {
      const old = await json(
        await rpc("SendMessage", invoke("guardPackage", { spec: "x" }), {
          ...asReader,
          "A2A-Version": "0.3",
        }),
      );
      expect(old.error.code).toBe(-32_009);

      const sent = await rpc("SendMessage", invoke("guardPackage", { spec: "x" }), {
        ...asReader,
        "A2A-Version": "1.0",
      });
      expect((await json(sent)).result.task).toBeDefined();

      const unknown = await json(await rpc("message/send", {}, asReader));
      expect(unknown.error.code).toBe(-32_601);

      const envelope = await fetch(`${origin}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...asReader },
        body: JSON.stringify({ method: "GetTask" }),
      });
      expect((await json(envelope)).error.code).toBe(-32_600);

      const garbage = await fetch(`${origin}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...asReader },
        body: "{nope",
      });
      expect((await json(garbage)).error.code).toBe(-32_700);
    });

    it("returns a finished task again from GetTask, to a caller with the same role", async () => {
      const sent = await json(
        await rpc("SendMessage", invoke("remediate", { cveId: "CVE-2021-23337" }), asAdmin),
      );
      const id = sent.result.task.id as string;

      const got = await json(await rpc("GetTask", { id }, asAdmin));
      expect(got.result.id).toBe(id);
      expect(got.result.status.state).toBe("TASK_STATE_COMPLETED");

      const trimmed = await json(await rpc("GetTask", { id, historyLength: 0 }, asAdmin));
      expect(trimmed.result.history).toBeUndefined();

      const forbidden = await rpc("GetTask", { id }, asReader);
      expect(forbidden.status).toBe(403);

      const missing = await json(await rpc("GetTask", { id: "nope" }, asReader));
      expect(missing.error.code).toBe(-32_001);
    });

    it("does not show one caller's task to another caller who holds the same role", async () => {
      vi.stubEnv(
        "AUTOREMEDIATOR_API_TOKENS",
        "admin:adm-SECRET,reader:rdr-SECRET,reader:rdr-OTHER",
      );
      const sent = await json(
        await rpc("SendMessage", invoke("guardPackage", { spec: "left-pad" }), asReader),
      );
      const id = sent.result.task.id as string;

      const other = await json(await rpc("GetTask", { id }, { Authorization: "Bearer rdr-OTHER" }));
      expect(other.error.code).toBe(-32_001);
      expect(other.result).toBeUndefined();

      const same = await json(await rpc("GetTask", { id }, asReader));
      expect(same.result.id).toBe(id);
    });

    it("tells callers apart by the subject of their JWT, not by the token text", async () => {
      const secret = "jwt-SECRET-value";
      const jwt = (sub: string, exp: number) => ({
        Authorization: `Bearer ${createSignedJwt({ sub, role: "reader", exp }, secret)}`,
      });
      const future = Math.floor(Date.now() / 1000) + 3600;
      const sent = await json(
        await rpc(
          "SendMessage",
          invoke("guardPackage", { spec: "left-pad" }),
          jwt("alice", future),
        ),
      );
      const id = sent.result.task.id as string;

      // A refreshed token for the same subject reads it; another subject with the same role does not.
      expect((await json(await rpc("GetTask", { id }, jwt("alice", future + 60)))).result.id).toBe(
        id,
      );
      expect((await json(await rpc("GetTask", { id }, jwt("mallory", future)))).error.code).toBe(
        -32_001,
      );
    });

    it("keeps only a short copy of the caller's message, but answers with the whole thing", async () => {
      const big = "x".repeat(400_000);
      const message = invoke("guardPackage", { spec: "left-pad" });
      message.message.parts.push({ text: big } as never);
      const sent = await json(await rpc("SendMessage", message, asReader));
      expect(JSON.stringify(sent.result.task.history)).toContain(big);
      const id = sent.result.task.id as string;

      const got = await json(await rpc("GetTask", { id }, asReader));
      expect(got.result.history).toHaveLength(1);
      const kept = JSON.stringify(got.result.history);
      expect(kept.length).toBeLessThan(4096);
      expect(kept).not.toContain(big);
      // What the caller asked for is still recognisable.
      expect(got.result.history[0].messageId).toBe("m1");
      expect(got.result.history[0].parts[0].data.operation).toBe("guardPackage");
    });
  });
});
