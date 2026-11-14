import { codeScanningAlertTarget, dependabotAlertTarget } from "./alerts.js";
import { parseComment } from "./commands.js";
import type { AppStateStore } from "./state.js";
import type {
  DispatchResult,
  RemediationJobResult,
  RemediationTriggerContext,
  WebhookContext,
} from "./types.js";

interface DispatchOptions {
  stateStore?: AppStateStore;
  onRemediationRequested?: (
    context: RemediationTriggerContext,
  ) => Promise<RemediationJobResult | void> | RemediationJobResult | void;
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

async function runWithTimeout(task: unknown, timeoutMs: number): Promise<void> {
  await Promise.race([
    Promise.resolve(task),
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

export async function dispatchGitHubEvent(
  context: WebhookContext,
  payload: Record<string, unknown>,
  options: DispatchOptions = {},
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

    if (
      ["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"].includes(action)
    ) {
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
      return {
        status: "ignored",
        reason: `check_suite action not triggerable: ${action ?? "unknown"}`,
      };
    }

    const installationId = readInstallationId(payload);
    if (
      installationId &&
      options.stateStore &&
      !options.stateStore.isInstallationActive(installationId)
    ) {
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
    if (
      installationId &&
      options.stateStore &&
      !options.stateStore.isInstallationActive(installationId)
    ) {
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
    if (
      installationId &&
      options.stateStore &&
      !options.stateStore.isInstallationActive(installationId)
    ) {
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

  if (context.eventName === "check_run") {
    const action = readAction(payload);
    if (action !== "completed") {
      return {
        status: "ignored",
        reason: `check_run action not completed: ${action ?? "unknown"}`,
      };
    }

    const checkRun = payload.check_run as Record<string, unknown> | undefined;
    const conclusion = checkRun?.conclusion as string | undefined;
    if (conclusion !== "failure") {
      return {
        status: "ignored",
        reason: `check_run conclusion not failure: ${conclusion ?? "unknown"}`,
      };
    }

    const pullRequests =
      (checkRun?.pull_requests as Array<Record<string, unknown>> | undefined) ?? [];
    const isAutoremediatorPr = pullRequests.some((pr) => {
      const head = pr.head as Record<string, unknown> | undefined;
      const ref = typeof head?.ref === "string" ? head.ref : "";
      return ref.startsWith("autoremediator/") || ref.includes("autoremediator");
    });

    if (!isAutoremediatorPr && pullRequests.length > 0) {
      return {
        status: "ignored",
        reason: "check_run failure not on an autoremediator pull request branch",
      };
    }

    const installationId = readInstallationId(payload);
    if (
      installationId &&
      options.stateStore &&
      !options.stateStore.isInstallationActive(installationId)
    ) {
      return { status: "ignored", reason: `Installation ${installationId} is not active` };
    }

    try {
      const triggerTask = options.onRemediationRequested?.({
        eventName: "check_run",
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

  if (context.eventName === "issue_comment") {
    if (readAction(payload) !== "created") {
      return { status: "ignored", reason: "issue_comment action is not created" };
    }
    const comment = payload.comment as Record<string, unknown> | undefined;
    const user = comment?.user as Record<string, unknown> | undefined;
    const login = typeof user?.login === "string" ? user.login : "";
    // Never react to bots (including this app's own replies, which mention the commands).
    if (user?.type === "Bot" || login.endsWith("[bot]")) {
      return { status: "ignored", reason: "comment written by a bot" };
    }
    const body = typeof comment?.body === "string" ? comment.body : "";
    if (!parseComment(body)) {
      return { status: "ignored", reason: "comment has no autoremediator command" };
    }
    return triggerRemediation(context, payload, options, "issue_comment");
  }

  if (context.eventName === "dependabot_alert" || context.eventName === "code_scanning_alert") {
    const action = readAction(payload);
    if (action !== "created" && action !== "reopened") {
      return { status: "ignored", reason: `${context.eventName} action not triggerable: ${action ?? "unknown"}` };
    }
    const target =
      context.eventName === "dependabot_alert"
        ? dependabotAlertTarget(payload)
        : codeScanningAlertTarget(payload);
    if (!target) {
      return { status: "ignored", reason: `${context.eventName} does not name a CVE or GHSA advisory` };
    }
    return triggerRemediation(context, payload, options, context.eventName);
  }

  void payload;
  return { status: "ignored", reason: `Unhandled event type: ${context.eventName}` };
}

async function triggerRemediation(
  context: WebhookContext,
  payload: Record<string, unknown>,
  options: DispatchOptions,
  eventName: "issue_comment" | "dependabot_alert" | "code_scanning_alert",
): Promise<DispatchResult> {
  const installationId = readInstallationId(payload);
  if (installationId && options.stateStore && !options.stateStore.isInstallationActive(installationId)) {
    return { status: "ignored", reason: `Installation ${installationId} is not active` };
  }
  try {
    const triggerTask = options.onRemediationRequested?.({
      eventName,
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
