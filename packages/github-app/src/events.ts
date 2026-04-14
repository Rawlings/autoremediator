import type { DispatchResult, RemediationJobResult, RemediationTriggerContext, WebhookContext } from "./types.js";
import type { AppStateStore } from "./state.js";

interface DispatchOptions {
  stateStore?: AppStateStore;
  onRemediationRequested?: (context: RemediationTriggerContext) => Promise<RemediationJobResult | void> | RemediationJobResult | void;
  remediationTriggerTimeoutMs?: number;
}

function readAction(payload: Record<string, unknown>): string | undefined {
  const action = payload.action;
  return typeof action === "string" ? action : undefined;
}

function readInstallationId(payload: Record<string, unknown>): number | undefined {
  const installation = payload.installation;
  if (!installation || typeof installation !== "object") {
    return undefined;
  }

  const id = (installation as { id?: unknown }).id;
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

async function runWithTimeout(task: Promise<unknown> | unknown, timeoutMs: number): Promise<void> {
  await Promise.race([
    Promise.resolve(task),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

export async function dispatchGitHubEvent(
  context: WebhookContext,
  payload: Record<string, unknown>,
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  if (context.eventName === "ping") {
    return { status: "handled" };
  }

  if (context.eventName === "installation") {
    const action = readAction(payload);
    const installationId = readInstallationId(payload);
    if (!action) {
      return { status: "ignored", reason: "Missing installation action" };
    }

    if (!installationId) {
      return { status: "ignored", reason: "Missing installation id" };
    }

    if (["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"].includes(action)) {
      if (action === "created" || action === "unsuspend" || action === "new_permissions_accepted") {
        options.stateStore?.markInstallationActive(installationId);
      }

      if (action === "deleted" || action === "suspend") {
        options.stateStore?.markInstallationInactive(installationId);
      }

      return { status: "handled" };
    }

    return { status: "ignored", reason: `Unsupported installation action: ${action}` };
  }

  if (context.eventName === "installation_repositories") {
    const action = readAction(payload);
    const installationId = readInstallationId(payload);
    if (!action) {
      return { status: "ignored", reason: "Missing installation_repositories action" };
    }

    if (!installationId) {
      return { status: "ignored", reason: "Missing installation id" };
    }

    if (options.stateStore && !options.stateStore.isInstallationActive(installationId)) {
      return { status: "ignored", reason: `Installation ${installationId} is not active` };
    }

    if (["added", "removed"].includes(action)) {
      return { status: "handled" };
    }

    return {
      status: "ignored",
      reason: `Unsupported installation_repositories action: ${action}`,
    };
  }

  if (context.eventName === "check_suite") {
    const action = readAction(payload);
    if (action !== "requested" && action !== "rerequested") {
      return { status: "ignored", reason: `check_suite action not triggerable: ${action ?? "unknown"}` };
    }

    const installationId = readInstallationId(payload);
    if (installationId && options.stateStore && !options.stateStore.isInstallationActive(installationId)) {
      return { status: "ignored", reason: `Installation ${installationId} is not active` };
    }

    try {
      const triggerTask = options.onRemediationRequested?.({
        eventName: "check_suite",
        installationId,
        deliveryId: context.deliveryId,
        payload,
      });

      if (options.remediationTriggerTimeoutMs !== undefined && triggerTask !== undefined) {
        await runWithTimeout(triggerTask, options.remediationTriggerTimeoutMs);
      } else {
        await triggerTask;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown remediation trigger error";
      return { status: "handled", reason: `Remediation trigger failed: ${message}` };
    }

    return { status: "handled" };
  }

  if (context.eventName === "push") {
    const installationId = readInstallationId(payload);
    if (installationId && options.stateStore && !options.stateStore.isInstallationActive(installationId)) {
      return { status: "ignored", reason: `Installation ${installationId} is not active` };
    }

    // Only trigger on pushes to the default branch
    const ref = typeof payload.ref === "string" ? payload.ref : undefined;
    const defaultBranch = (() => {
      const repo = payload.repository;
      if (repo && typeof repo === "object") {
        const db = (repo as Record<string, unknown>).default_branch;
        return typeof db === "string" ? db : undefined;
      }
      return undefined;
    })();

    if (!ref || !defaultBranch || ref !== `refs/heads/${defaultBranch}`) {
      return { status: "ignored", reason: `push to non-default branch (${ref ?? "unknown"})` };
    }

    try {
      const triggerTask = options.onRemediationRequested?.({
        eventName: "push",
        installationId,
        deliveryId: context.deliveryId,
        payload,
      });

      if (options.remediationTriggerTimeoutMs !== undefined && triggerTask !== undefined) {
        await runWithTimeout(triggerTask, options.remediationTriggerTimeoutMs);
      } else {
        await triggerTask;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown remediation trigger error";
      return { status: "handled", reason: `Remediation trigger failed: ${message}` };
    }

    return { status: "handled" };
  }

  if (context.eventName === "workflow_dispatch") {
    const installationId = readInstallationId(payload);
    if (installationId && options.stateStore && !options.stateStore.isInstallationActive(installationId)) {
      return { status: "ignored", reason: `Installation ${installationId} is not active` };
    }

    try {
      const triggerTask = options.onRemediationRequested?.({
        eventName: "workflow_dispatch",
        installationId,
        deliveryId: context.deliveryId,
        payload,
      });

      if (options.remediationTriggerTimeoutMs !== undefined && triggerTask !== undefined) {
        await runWithTimeout(triggerTask, options.remediationTriggerTimeoutMs);
      } else {
        await triggerTask;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown remediation trigger error";
      return { status: "handled", reason: `Remediation trigger failed: ${message}` };
    }

    return { status: "handled" };
  }

  void payload;
  return { status: "ignored", reason: `Unhandled event type: ${context.eventName}` };
}
