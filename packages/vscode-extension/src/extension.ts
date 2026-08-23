import * as vscode from "vscode";
import {
  scanForVulns,
  applyFix,
  checkPackageReachability,
  scanGitDelta,
  type VulnFinding,
} from "./runner";
import { PatchDiffProvider, PATCH_SCHEME } from "./patch-diff-provider";

const DIAGNOSTIC_SOURCE = "autoremediator";

let diagnosticCollection: vscode.DiagnosticCollection;

// Keyed by document URI string → findings used to drive code actions, hovers, and CodeLens.
const findingsCache = new Map<string, VulnFinding[]>();

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  const patchDiffProvider = new PatchDiffProvider();

  context.subscriptions.push(
    diagnosticCollection,
    vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, patchDiffProvider),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isPackageJson(doc)) void scheduleScan(doc);
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isPackageJson(doc)) void scheduleScan(doc, true);
    }),

    vscode.languages.registerCodeActionsProvider(
      { pattern: "**/package.json", scheme: "file" },
      new RemediateActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),

    vscode.languages.registerHoverProvider(
      { pattern: "**/package.json", scheme: "file" },
      new PackageHoverProvider(),
    ),

    vscode.languages.registerCodeLensProvider(
      { pattern: "**/package.json", scheme: "file" },
      new PackageCodeLensProvider(),
    ),

    vscode.commands.registerCommand("autoremediator.scanWorkspace", () => {
      for (const doc of vscode.workspace.textDocuments) {
        if (isPackageJson(doc)) void scheduleScan(doc, true);
      }
    }),

    vscode.commands.registerCommand("autoremediator.scanDelta", async () => {
      const activeDoc = vscode.window.activeTextEditor?.document;
      const cwd =
        activeDoc && isPackageJson(activeDoc)
          ? vscode.Uri.joinPath(vscode.Uri.file(activeDoc.fileName), "..").fsPath
          : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      if (!cwd) {
        void vscode.window.showWarningMessage("Autoremediator: No workspace open to scan delta.");
        return;
      }

      try {
        const delta = await scanGitDelta(cwd, "HEAD");
        const icon =
          delta.netRiskVerdict === "degraded"
            ? "⚠️"
            : delta.netRiskVerdict === "improved"
              ? "✅"
              : "ℹ️";
        void vscode.window.showInformationMessage(`Autoremediator Delta: ${icon} ${delta.summary}`);
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(
          `Autoremediator delta scan failed: ${(err as Error).message}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      "autoremediator.checkReachability",
      async (pkgName?: string) => {
        const activeDoc = vscode.window.activeTextEditor?.document;
        const cwd =
          activeDoc && isPackageJson(activeDoc)
            ? vscode.Uri.joinPath(vscode.Uri.file(activeDoc.fileName), "..").fsPath
            : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!cwd) {
          void vscode.window.showWarningMessage(
            "Autoremediator: No workspace open for reachability check.",
          );
          return;
        }

        const targetPkg =
          pkgName ??
          (await vscode.window.showInputBox({
            prompt: "Enter package name to analyze AST call-graph reachability",
            placeHolder: "e.g. lodash, express, semver",
          }));

        if (!targetPkg) return;

        try {
          const res = await checkPackageReachability(targetPkg, cwd);
          void vscode.window.showInformationMessage(
            `Reachability for ${targetPkg}: ${res.status.toUpperCase()} — ${res.reason}`,
          );
        } catch (err: unknown) {
          void vscode.window.showErrorMessage(
            `Reachability check failed: ${(err as Error).message}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand("autoremediator.previewPatch", (patchFilePath: string) => {
      const uri = vscode.Uri.from({
        scheme: PATCH_SCHEME,
        path: patchFilePath,
      });
      void vscode.commands.executeCommand("vscode.open", uri, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),

    vscode.commands.registerCommand("autoremediator.fixCve", (cveId: string, cwd: string) => {
      void applyFix(cveId, cwd)
        .then((output) => {
          void vscode.window.showInformationMessage(`Autoremediator: ${output}`);
          // Refresh diagnostics after fix.
          for (const doc of vscode.workspace.textDocuments) {
            if (isPackageJson(doc)) void scheduleScan(doc, true);
          }
        })
        .catch((err: Error) => {
          void vscode.window.showErrorMessage(`Autoremediator fix failed: ${err.message}`);
        });
    }),
  );

  // Scan files already open when the extension activates.
  for (const doc of vscode.workspace.textDocuments) {
    if (isPackageJson(doc)) void scheduleScan(doc);
  }
}

export function deactivate(): void {
  diagnosticCollection.dispose();
}

function isPackageJson(doc: vscode.TextDocument): boolean {
  return doc.fileName.endsWith("package.json") && !doc.fileName.includes("node_modules");
}

async function scheduleScan(doc: vscode.TextDocument, force = false): Promise<void> {
  const cwd = vscode.Uri.joinPath(vscode.Uri.file(doc.fileName), "..").fsPath;
  try {
    const findings = await scanForVulns(cwd, force);
    findingsCache.set(doc.uri.toString(), findings);
    diagnosticCollection.set(doc.uri, buildDiagnostics(doc, findings));
  } catch {
    // Autoremediator may not be installed; fail silently.
    diagnosticCollection.delete(doc.uri);
  }
}

function buildDiagnostics(doc: vscode.TextDocument, findings: VulnFinding[]): vscode.Diagnostic[] {
  const text = doc.getText();
  const diagnostics: vscode.Diagnostic[] = [];

  for (const finding of findings) {
    const range = findPackageRange(text, doc, finding.packageName);
    if (!range) continue;

    const severity =
      finding.severity === "CRITICAL" || finding.severity === "HIGH"
        ? vscode.DiagnosticSeverity.Error
        : finding.severity === "MEDIUM"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;

    const kevText = finding.inCisaKev ? " [🚨 CISA KEV Exploited]" : "";
    const epssText = finding.epssScore ? ` [EPSS ${(finding.epssScore * 100).toFixed(1)}%]` : "";
    const fixText = finding.safeUpgradeVersion
      ? ` Fix: upgrade to ${finding.safeUpgradeVersion}.`
      : "";

    const diag = new vscode.Diagnostic(
      range,
      `[${finding.cveId}]${kevText}${epssText} ${finding.summary}${fixText}`,
      severity,
    );
    diag.source = DIAGNOSTIC_SOURCE;
    diag.code = finding.cveId;
    diagnostics.push(diag);
  }

  return diagnostics;
}

function findPackageRange(
  text: string,
  doc: vscode.TextDocument,
  packageName: string,
): vscode.Range | undefined {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"${escaped}"\\s*:`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = doc.positionAt(match.index);
    const end = doc.positionAt(match.index + match[0].length);
    return new vscode.Range(start, end);
  }
  return undefined;
}

class RemediateActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const findings = findingsCache.get(document.uri.toString()) ?? [];
    const cwd = vscode.Uri.joinPath(vscode.Uri.file(document.fileName), "..").fsPath;
    const actions: vscode.CodeAction[] = [];

    for (const finding of findings) {
      const pkgRange = findPackageRange(document.getText(), document, finding.packageName);
      if (!pkgRange?.intersection(range)) continue;

      const action = new vscode.CodeAction(
        `Fix ${finding.packageName} (${finding.cveId}) with Autoremediator`,
        vscode.CodeActionKind.QuickFix,
      );
      action.command = {
        command: "autoremediator.fixCve",
        title: "Fix with Autoremediator",
        arguments: [finding.cveId, cwd],
      };
      actions.push(action);

      const reachAction = new vscode.CodeAction(
        `Check reachability for ${finding.packageName}`,
        vscode.CodeActionKind.Empty,
      );
      reachAction.command = {
        command: "autoremediator.checkReachability",
        title: "Check reachability",
        arguments: [finding.packageName],
      };
      actions.push(reachAction);
    }

    return actions;
  }
}

class PackageHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const findings = findingsCache.get(document.uri.toString()) ?? [];
    if (findings.length === 0) return undefined;

    const text = document.getText();
    for (const finding of findings) {
      const range = findPackageRange(text, document, finding.packageName);
      if (!range?.contains(position)) continue;

      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.appendMarkdown(`### 🛡️ Autoremediator Security Intel: \`${finding.packageName}\`\n\n`);
      md.appendMarkdown(
        `**CVE:** [${finding.cveId}](https://nvd.nist.gov/vuln/detail/${finding.cveId}) | **Severity:** \`${finding.severity}\`\n\n`,
      );

      if (finding.inCisaKev) {
        md.appendMarkdown(`🚨 **CISA KEV:** Active exploitation confirmed in the wild.\n\n`);
      }
      if (finding.epssScore !== undefined) {
        md.appendMarkdown(
          `📊 **EPSS Score:** ${(finding.epssScore * 100).toFixed(1)}% (${((finding.epssPercentile ?? 0) * 100).toFixed(0)}th percentile)\n\n`,
        );
      }
      if (finding.reachabilityStatus) {
        md.appendMarkdown(
          `🔍 **AST Reachability:** \`${finding.reachabilityStatus.toUpperCase()}\`\n\n`,
        );
      }

      md.appendMarkdown(`**Summary:** ${finding.summary}\n\n`);

      if (finding.safeUpgradeVersion) {
        md.appendMarkdown(`💡 **Safe Version:** \`${finding.safeUpgradeVersion}\`\n\n`);
      }

      const cwd = vscode.Uri.joinPath(vscode.Uri.file(document.fileName), "..").fsPath;
      const fixUri = vscode.Uri.parse(
        `command:autoremediator.fixCve?${encodeURIComponent(JSON.stringify([finding.cveId, cwd]))}`,
      );
      const reachUri = vscode.Uri.parse(
        `command:autoremediator.checkReachability?${encodeURIComponent(JSON.stringify([finding.packageName]))}`,
      );

      md.appendMarkdown(
        `[⚡ Auto-Remediate](${fixUri.toString()}) &nbsp;|&nbsp; [🔬 Check Reachability](${reachUri.toString()})`,
      );
      return new vscode.Hover(md, range);
    }

    return undefined;
  }
}

class PackageCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const findings = findingsCache.get(document.uri.toString()) ?? [];
    if (findings.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();

    // Place a CodeLens above the "dependencies" key
    const depMatch = /"(dependencies|devDependencies)"\s*:/g.exec(text);
    if (depMatch) {
      const pos = document.positionAt(depMatch.index);
      const range = new vscode.Range(pos, pos);
      const fixableCount = findings.filter((f) => Boolean(f.safeUpgradeVersion)).length;

      lenses.push(
        new vscode.CodeLens(range, {
          title: `🛡️ ${findings.length} CVE(s) detected (${fixableCount} fixable) • [Scan Delta]`,
          command: "autoremediator.scanDelta",
        }),
      );
    }

    return lenses;
  }
}
