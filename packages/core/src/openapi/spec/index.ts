import { A2A_ENDPOINT_PATH, AGENT_CARD_PATH } from "../../a2a/index.js";
import { toOpenApiPaths } from "../../catalog/index.js";
import { PACKAGE_VERSION } from "../../version.js";

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "autoremediator",
    version: PACKAGE_VERSION,
    description: "Agentic CVE remediation for Node.js dependency projects: plan, fix, repair, verify, roll back on failure",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development server",
    },
  ],
  "x-agent-compatible": true,
  "x-agent-use-cases": [
    "plan-first remediation",
    "scanner-driven batch remediation",
    "patch lifecycle validation",
  ],
  // Generated from the operation catalog, so it cannot drift from what the server accepts.
  paths: {
    ...toOpenApiPaths(),
    [AGENT_CARD_PATH]: {
      get: {
        operationId: "a2aAgentCard",
        summary: "A2A Agent Card",
        description:
          "Public Agent2Agent discovery document (A2A 1.0). Signed when AUTOREMEDIATOR_A2A_SIGNING_KEY is set.",
        responses: {
          "200": {
            description: "The Agent Card",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    [A2A_ENDPOINT_PATH]: {
      post: {
        operationId: "a2aJsonRpc",
        summary: "A2A JSON-RPC endpoint (SendMessage, GetTask)",
        description:
          "Agent2Agent 1.0 JSON-RPC binding. SendMessage runs the catalog operation named in a data part and returns a completed or failed task; GetTask returns a task again. Requires a bearer token.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "200": {
            description: "A JSON-RPC 2.0 response",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
} as const;
