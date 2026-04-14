import http from "node:http";
import type { PatchArtifactQueryOptions, RemediateOptions, ScanOptions, UpdateOutdatedOptions } from "../../api/index.js";
import { OPENAPI_SPEC } from "../spec/index.js";
import { sendJson, withOpenApiSource } from "../http-utils.js";
import type { OpenApiServerDeps } from "../server.js";
import { readJsonBody, requireStringField, runRequest } from "./validators.js";

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function createOpenApiRouteHandlers(deps: OpenApiServerDeps): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();

  routes.set("GET /health", async (_req, res) => {
    sendJson(res, 200, { status: "ok" });
  });

  routes.set("GET /openapi.json", async (_req, res) => {
    sendJson(res, 200, OPENAPI_SPEC);
  });

  routes.set("POST /remediate", async (req, res) => {
    const body = await readJsonBody<{ cveId?: unknown; options?: unknown }>(req, res);
    const cveId = requireStringField(body as Record<string, unknown> | undefined, "cveId", res, "cveId is required (string)");
    if (!cveId) return;

    await runRequest(res, () =>
      deps.remediateFn(cveId, withOpenApiSource(body?.options) as RemediateOptions)
    );
  });

  routes.set("POST /plan-remediation", async (req, res) => {
    const body = await readJsonBody<{ cveId?: unknown; options?: unknown }>(req, res);
    const cveId = requireStringField(body as Record<string, unknown> | undefined, "cveId", res, "cveId is required (string)");
    if (!cveId) return;

    await runRequest(res, () =>
      deps.planRemediationFn(cveId, withOpenApiSource(body?.options) as RemediateOptions)
    );
  });

  routes.set("POST /remediate-from-scan", async (req, res) => {
    const body = await readJsonBody<{ inputPath?: unknown; options?: unknown }>(req, res);
    const inputPath = requireStringField(
      body as Record<string, unknown> | undefined,
      "inputPath",
      res,
      "inputPath is required (string)"
    );
    if (!inputPath) return;

    await runRequest(res, () =>
      deps.remediateFromScanFn(inputPath, withOpenApiSource(body?.options) as ScanOptions)
    );
  });

  routes.set("POST /patches/list", async (req, res) => {
    const body = await readJsonBody<{ options?: unknown }>(req, res);
    if (!body) return;
    await runRequest(res, () => deps.listPatchArtifactsFn(body.options as PatchArtifactQueryOptions));
  });

  routes.set("POST /patches/inspect", async (req, res) => {
    const body = await readJsonBody<{ patchFilePath?: unknown; options?: unknown }>(req, res);
    const patchFilePath = requireStringField(
      body as Record<string, unknown> | undefined,
      "patchFilePath",
      res,
      "patchFilePath is required (string)"
    );
    if (!patchFilePath) return;
    await runRequest(res, () =>
      deps.inspectPatchArtifactFn(patchFilePath, body?.options as PatchArtifactQueryOptions)
    );
  });

  routes.set("POST /patches/validate", async (req, res) => {
    const body = await readJsonBody<{ patchFilePath?: unknown; options?: unknown }>(req, res);
    const patchFilePath = requireStringField(
      body as Record<string, unknown> | undefined,
      "patchFilePath",
      res,
      "patchFilePath is required (string)"
    );
    if (!patchFilePath) return;
    await runRequest(res, () =>
      deps.validatePatchArtifactFn(patchFilePath, body?.options as PatchArtifactQueryOptions)
    );
  });

  routes.set("POST /update-outdated", async (req, res) => {
    const body = await readJsonBody<{ options?: unknown }>(req, res);
    if (!body) return;
    await runRequest(res, () =>
      deps.updateOutdatedFn(withOpenApiSource(body.options) as UpdateOutdatedOptions)
    );
  });

  return routes;
}