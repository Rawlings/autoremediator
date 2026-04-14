import { randomUUID } from "node:crypto";

export function generateStateToken(): string {
  return randomUUID();
}

export function parseStateCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key?.trim() === "autoremediator_setup_state") {
      return rest.join("=").trim() || undefined;
    }
  }
  return undefined;
}

export interface ManifestConversionResult {
  appId: number;
  name: string;
  slug: string;
  webhookSecret: string;
  pem: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
  ownerLogin: string;
}

export function resolveBaseUrl(hostHeader: string | undefined): string {
  const host = hostHeader ?? "localhost:3001";
  const isLocal =
    host.startsWith("localhost") ||
    host.startsWith("127.") ||
    host === "[::1]" ||
    host.startsWith("[::1]:");
  return `${isLocal ? "http" : "https"}://${host}`;
}

export function buildAppManifest(baseUrl: string): Record<string, unknown> {
  const normalized = baseUrl.replace(/\/$/, "");
  return {
    name: "autoremediator",
    url: "https://github.com/rawlings/autoremediator",
    hook_attributes: {
      url: `${normalized}/webhook`,
    },
    redirect_url: `${normalized}/setup/complete`,
    setup_url: `${normalized}/install`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "write",
      metadata: "read",
    },
    default_events: [
      "check_suite",
      "installation",
      "installation_repositories",
      "push",
      "workflow_dispatch",
    ],
  };
}

export async function exchangeManifestCode(
  code: string,
  githubApiUrl: string = "https://api.github.com"
): Promise<ManifestConversionResult> {
  const url = `${githubApiUrl.replace(/\/$/, "")}/app-manifests/${encodeURIComponent(code)}/conversions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "autoremediator-github-app",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub manifest exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    id: number;
    name: string;
    slug: string;
    webhook_secret: string;
    pem: string;
    client_id: string;
    client_secret: string;
    html_url: string;
    owner?: { login?: string };
  };

  return {
    appId: data.id,
    name: data.name,
    slug: data.slug,
    webhookSecret: data.webhook_secret,
    pem: data.pem,
    clientId: data.client_id,
    clientSecret: data.client_secret,
    htmlUrl: data.html_url,
    ownerLogin: data.owner?.login ?? "",
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function renderSetupPage(
  baseUrl: string,
  githubUrl: string = "https://github.com",
  state: string = ""
): string {
  const normalized = baseUrl.replace(/\/$/, "");
  const manifest = buildAppManifest(normalized);
  const manifestJson = JSON.stringify(manifest);
  const createUrl = `${githubUrl.replace(/\/$/, "")}/settings/apps/new`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>autoremediator — Register GitHub App</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;color:#24292f}
    h1{font-size:22px;margin-bottom:6px}
    p{color:#57606a;line-height:1.6}
    .card{border:1px solid #d0d7de;border-radius:8px;padding:24px;margin:24px 0;background:#f6f8fa}
    .btn{background:#2da44e;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
    .btn:hover{background:#2c974b}
    .step{display:flex;gap:12px;margin:14px 0;align-items:flex-start}
    .num{background:#0969da;color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:2px}
    code{background:#eaeef2;padding:2px 6px;border-radius:4px;font-size:12px}
    .meta{font-size:12px;color:#6e7781;margin-top:8px}
  </style>
</head>
<body>
  <h1>Register autoremediator as a GitHub App</h1>
  <p>Click the button to register the app on GitHub. Permissions, events, and the webhook URL are pre-filled from this server's manifest — no manual GitHub configuration required.</p>
  <div class="card">
    <div class="step"><div class="num">1</div><div>Click <strong>Create GitHub App on GitHub</strong> below. GitHub opens a pre-filled registration form.</div></div>
    <div class="step"><div class="num">2</div><div>Review the app name, then click <strong>Create GitHub App</strong> on the GitHub page.</div></div>
    <div class="step"><div class="num">3</div><div>You will be redirected back here with your credentials. Copy them into your environment and restart the server.</div></div>
    <div class="step"><div class="num">4</div><div>Install the app on the repositories you want to remediate.</div></div>
    <form action="${escapeHtml(createUrl)}?state=${encodeURIComponent(state)}" method="post" style="margin-top:20px">
      <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
      <button type="submit" class="btn">Create GitHub App on GitHub &rarr;</button>
    </form>
  </div>
  <p class="meta">
    Webhook URL: <code>${escapeHtml(normalized)}/webhook</code> &nbsp;&middot;&nbsp;
    Permissions: <code>contents:write</code> <code>pull_requests:write</code> <code>checks:write</code> <code>metadata:read</code><br>
    Events: <code>check_suite</code> <code>installation</code> <code>installation_repositories</code> <code>workflow_dispatch</code>
  </p>
</body>
</html>`;
}

export function renderSetupCompletePage(result: ManifestConversionResult): string {
  const installUrl = `${escapeHtml(result.htmlUrl)}/installations/new`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>autoremediator — App Created</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;color:#24292f}
    h1{font-size:22px}
    p{color:#57606a;line-height:1.6}
    .card{border:1px solid #d0d7de;border-radius:8px;padding:20px;margin:20px 0;background:#f6f8fa}
    .cred{margin:14px 0}
    .cred label{font-size:11px;font-weight:700;color:#57606a;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px}
    .cred code{display:block;background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:10px 12px;font-size:12px;word-break:break-all;white-space:pre-wrap}
    .warn{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:12px 16px;font-size:13px;margin:16px 0}
    .ok{color:#1a7f37}
    a{color:#0969da}
  </style>
</head>
<body>
  <h1><span class="ok">&#10003;</span> GitHub App created</h1>
  <p>App <strong>${escapeHtml(result.name)}</strong> registered successfully. <a href="${escapeHtml(result.htmlUrl)}" target="_blank" rel="noreferrer">View on GitHub</a></p>
  <div class="warn"><strong>Save these credentials now.</strong> The private key and webhook secret are shown once and cannot be retrieved again.</div>
  <div class="card">
    <div class="cred"><label>AUTOREMEDIATOR_GITHUB_APP_ID</label><code>${result.appId}</code></div>
    <div class="cred"><label>AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET</label><code>${escapeHtml(result.webhookSecret)}</code></div>
    <div class="cred"><label>AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY</label><code>${escapeHtml(result.pem)}</code></div>
  </div>
  <p>Set those three environment variables, restart the server, then <a href="${installUrl}" target="_blank" rel="noreferrer">install the app on your repositories</a> to begin receiving webhook events.</p>
</body>
</html>`;
}

export function renderAlreadyConfiguredPage(htmlUrl?: string): string {
  const appLink = htmlUrl
    ? `<a href="${escapeHtml(htmlUrl)}" target="_blank" rel="noreferrer">View app on GitHub</a>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>autoremediator — Already Configured</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;color:#24292f}
    h1{font-size:22px}
    p{color:#57606a;line-height:1.6}
    .ok{color:#1a7f37;font-weight:600}
    a{color:#0969da}
  </style>
</head>
<body>
  <h1><span class="ok">&#10003;</span> Already configured</h1>
  <p>This server already has a GitHub App ID set. Re-registration is disabled to protect existing credentials.</p>
  ${appLink ? `<p>${appLink}</p>` : ""}
  <p>To register a new app, stop the server, clear <code>AUTOREMEDIATOR_GITHUB_APP_ID</code>, and restart.</p>
</body>
</html>`;
}

export function renderSetupForbiddenPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>autoremediator — Forbidden</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;color:#24292f}
    h1{color:#cf222e;font-size:22px}
    p{color:#57606a;line-height:1.6}
  </style>
</head>
<body>
  <h1>Forbidden</h1>
  <p>A valid <code>secret</code> query parameter is required to access the setup page.</p>
</body>
</html>`;
}

export function renderSetupErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>autoremediator — Setup Error</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;color:#24292f}
    h1{color:#cf222e;font-size:22px}
    .card{border:1px solid #ffcdd2;border-radius:6px;padding:18px;background:#fff5f5}
    code{font-size:12px;word-break:break-all}
    a{color:#0969da}
  </style>
</head>
<body>
  <h1>Setup failed</h1>
  <div class="card"><code>${escapeHtml(message)}</code></div>
  <p><a href="/setup">&larr; Try again</a></p>
</body>
</html>`;
}

export function renderInstallPage(installationId?: string): string {
  const body = installationId
    ? `<p class="ok">&#10003; Installation ${escapeHtml(installationId)} active.</p>
  <p>Remediation will run on <code>check_suite</code> and <code>workflow_dispatch</code> events. Check the <a href="/health">health endpoint</a> for runtime counters.</p>`
    : `<p>App installed. Webhook events will flow to this server once repositories are selected.</p>
  <p>Check the <a href="/health">health endpoint</a> to verify the server is running.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>autoremediator — Installed</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;color:#24292f}
    h1{font-size:22px}
    p{color:#57606a;line-height:1.6}
    .ok{color:#1a7f37;font-weight:600}
    a{color:#0969da}
    code{background:#eaeef2;padding:2px 6px;border-radius:4px;font-size:12px}
  </style>
</head>
<body>
  <h1>autoremediator</h1>
  ${body}
</body>
</html>`;
}
