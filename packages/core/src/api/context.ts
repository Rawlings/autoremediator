import type {
  CorrelationContext,
  ProvenanceContext,
  RemediateOptions,
  RemediationConstraints,
} from "../platform/types.js";
import { loadPolicy } from "../platform/policy.js";

function buildRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveCorrelationContext(options: RemediateOptions): Required<Pick<CorrelationContext, "requestId">> & CorrelationContext {
  return {
    requestId: options.requestId ?? buildRequestId(),
    sessionId: options.sessionId,
    parentRunId: options.parentRunId,
  };
}

export function resolveProvenanceContext(options: RemediateOptions): ProvenanceContext {
  return {
    actor: options.actor,
    source: options.source ?? "sdk",
  };
}

export function resolveConstraints(options: RemediateOptions, cwd: string): RemediationConstraints {
  const policy = loadPolicy(cwd, options.policy);
  return {
    directDependenciesOnly:
      options.constraints?.directDependenciesOnly ??
      policy.constraints?.directDependenciesOnly ??
      false,
    preferVersionBump:
      options.constraints?.preferVersionBump ??
      policy.constraints?.preferVersionBump ??
      false,
    installMode:
      options.constraints?.installMode ??
      policy.constraints?.installMode ??
      "deterministic",
    installPreferOffline:
      options.constraints?.installPreferOffline ??
      policy.constraints?.installPreferOffline,
    enforceFrozenLockfile:
      options.constraints?.enforceFrozenLockfile ??
      policy.constraints?.enforceFrozenLockfile,
    workspace:
      options.constraints?.workspace ??
      policy.constraints?.workspace,
  };
}
