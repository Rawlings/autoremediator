/**
 * A2A (Agent2Agent) Agent Card, protocol version 1.0.
 *
 * Field names and shapes follow the A2A 1.0.0 specification (section 4.4, "Agent Discovery
 * Objects") and its normative proto (`a2a.proto`, package `lf.a2a.v1`) in JSON form. Nothing here
 * adds a field the specification does not define. See `docs/integrations/a2a.md` for sources.
 */
import { getOperation, roleFor, type Operation } from "../catalog/index.js";

/** The A2A protocol version the card advertises and the endpoint implements. */
export const A2A_PROTOCOL_VERSION = "1.0";

/** Where the card is served (A2A 1.0 section 8.2). */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/** Where the JSON-RPC binding is served. The card's `supportedInterfaces` points here. */
export const A2A_ENDPOINT_PATH = "/a2a";

/** Key of the bearer scheme in `securitySchemes`. */
export const BEARER_SCHEME_NAME = "bearerAuth";

const JSON_MEDIA_TYPE = "application/json";

const PROJECT_URL = "https://github.com/Diffra/autoremediator";

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

export interface AgentCardSignature {
  /** Base64url of the JSON protected header (`alg`, `typ`, `kid`). */
  protected: string;
  /** Base64url of the JWS signature. */
  signature: string;
}

export interface SecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

export interface SecurityScheme {
  httpAuthSecurityScheme: { description?: string; scheme: string; bearerFormat?: string };
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider: { organization: string; url: string };
  version: string;
  documentationUrl: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
  };
  securitySchemes: Record<string, SecurityScheme>;
  securityRequirements: SecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  signatures?: AgentCardSignature[];
}

/**
 * The operations offered over A2A: a curated subset of the catalog. Anything that edits the project
 * outside a run's own plan/apply flow (rollback, attempts, portfolio, jobs) stays on the HTTP API
 * and MCP.
 */
export const A2A_SKILL_NAMES = [
  "remediate",
  "planRemediation",
  "remediateFromScan",
  "guardPackage",
  "evaluatePackage",
  "scanDelta",
  "checkReachability",
  "verifyRun",
  "getRun",
  "listRuns",
  "toVex",
] as const;

const SKILL_TAGS: Record<(typeof A2A_SKILL_NAMES)[number], string[]> = {
  remediate: ["vulnerability", "remediation", "npm", "cve"],
  planRemediation: ["vulnerability", "remediation", "planning", "cve"],
  remediateFromScan: ["vulnerability", "remediation", "scanner", "sarif"],
  guardPackage: ["supply-chain", "malware", "npm", "install-guard"],
  evaluatePackage: ["supply-chain", "npm", "package-health"],
  scanDelta: ["vulnerability", "git", "delta"],
  checkReachability: ["vulnerability", "reachability", "triage"],
  verifyRun: ["verification", "remediation", "runs"],
  getRun: ["runs", "audit"],
  listRuns: ["runs", "audit"],
  toVex: ["vex", "cyclonedx", "reporting"],
};

/** The catalog operations behind the A2A skills. Throws if the catalog no longer has one. */
export function a2aSkillOperations(): Operation[] {
  return A2A_SKILL_NAMES.map((name) => {
    const operation = getOperation(name);
    if (!operation) throw new Error(`A2A skill "${name}" is not in the operation catalog`);
    return operation;
  });
}

/** Strip trailing slashes; only an absolute http(s) URL is a usable base. */
export function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid base URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Base URL must be http or https: ${baseUrl}`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function toSkill(operation: Operation): AgentSkill {
  const tags = SKILL_TAGS[operation.name as keyof typeof SKILL_TAGS] ?? [operation.name];
  return {
    id: operation.name,
    name: operation.title,
    description: `${operation.description} Requires the "${roleFor(operation)}" role.`,
    tags,
    inputModes: [JSON_MEDIA_TYPE],
    outputModes: [JSON_MEDIA_TYPE],
  };
}

/**
 * Build the Agent Card. Pure: the same inputs give the same card. Skills come from catalog
 * operations, so ids, names and descriptions cannot drift from what the server runs.
 */
export function buildAgentCard(input: {
  baseUrl: string;
  version: string;
  skills?: readonly Operation[];
}): AgentCard {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const operations = input.skills ?? a2aSkillOperations();

  return {
    name: "autoremediator",
    description:
      "Remediates vulnerable npm dependencies and screens packages before an agent installs them. " +
      "Delegate by sending a SendMessage request whose message carries one data part " +
      '{"operation": <skill id>, "input": {...}}; the operation runs and its result comes back as a ' +
      "JSON artifact on a completed task. Skills map one-to-one to operations of the " +
      "autoremediator HTTP API and MCP server. Streaming, push notifications and an extended card " +
      "are not supported.",
    supportedInterfaces: [
      {
        url: `${baseUrl}${A2A_ENDPOINT_PATH}`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: "Rawlings", url: PROJECT_URL },
    version: input.version,
    documentationUrl: `${PROJECT_URL}/blob/master/docs/integrations/a2a.md`,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      [BEARER_SCHEME_NAME]: {
        httpAuthSecurityScheme: {
          description:
            "Bearer token: either a static token from AUTOREMEDIATOR_API_TOKENS or an HS256 JWT " +
            "with a role claim (admin, operator or reader). The role decides which skills a token " +
            "may use; each skill's description names the role it needs.",
          scheme: "Bearer",
          bearerFormat: "JWT",
        },
      },
    },
    securityRequirements: [{ schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }],
    defaultInputModes: [JSON_MEDIA_TYPE],
    defaultOutputModes: [JSON_MEDIA_TYPE],
    skills: operations.map((operation) => toSkill(operation)),
  };
}
