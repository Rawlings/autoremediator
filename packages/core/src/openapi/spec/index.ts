import { PACKAGE_VERSION } from "../../version.js";
import { createOpenApiPaths } from "./paths.js";

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "autoremediator",
    version: PACKAGE_VERSION,
    description: "Agentic CVE remediation for Node.js dependency projects",
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
  paths: createOpenApiPaths(),
} as const;