import * as vscode from "vscode";
import { scanForVulns, applyFix, type VulnFinding } from "./runner";

const DIAGNOSTIC_SOURCE = "autoremediator";

let diagnosticCollection: vscode.DiagnosticCollection;

// Keyed by document URI string → findings used to drive code actions.
const findingsCache = new Map<string, VulnFinding[]>();

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);

  context.subscriptions.push(
    diagnosticCollection,

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isPackageJson(doc)) void scheduleScan(doc);
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isPackageJson(doc)) void scheduleScan(doc);
    }),

    vscode.languages.registerCodeActionsProvider(
      { pattern: "**/package.json", scheme: "file" },
      new RemediateActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),

    vscode.commands.registerCommand("autoremediator.scanWorkspace", () => {
      for (const doc of vscode.workspace.textDocuments) {
        if (isPackageJson(doc)) void scheduleScan(doc);
      }
    }),

    vscode.commands.registerCommand(
      "autoremediator.fixCve",
      (cveId: string, cwd: string) => {
        void applyFix(cveId, cwd)
          .then((output) => {
            vscode.window.showInformationMessage(`Autoremediator: ${output}`);
            // Refresh diagnostics after fix.
            for (const doc of vscode.workspace.textDocuments) {
              if (isPackageJson(doc)) void scheduleScan(doc);
            }
          })
          .catch((err: Error) => {
            vscode.window.showErrorMessage(`Autoremediator fix failed: ${err.message}`);
          });
      }
    )
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
  return (
    doc.fileName.endsWith("package.json") && !doc.fileName.includes("node_modules")
  );
}

async function scheduleScan(doc: vscode.TextDocument): Promise<void> {
  const cwd = vscode.Uri.joinPath(vscode.Uri.file(doc.fileName), "..").fsPath;
  try {
    const findings = await scanForVulns(cwd);
    findingsCache.set(doc.uri.toString(), findings);
    diagnosticCollection.set(doc.uri, buildDiagnostics(doc, findings));
  } catch {
    // Autoremediator may not be installed; fail silently.
    diagnosticCollection.delete(doc.uri);
  }
}

function buildDiagnostics(
  doc: vscode.TextDocument,
  findings: VulnFinding[]
): vscode.Diagnostic[] {
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

    const fixText = finding.safeUpgradeVersion
      ? ` Fix: upgrade to ${finding.safeUpgradeVersion}.`
      : "";

    const diag = new vscode.Diagnostic(
      range,
      `[${finding.cveId}] ${finding.summary}${fixText}`,
      severity
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
  packageName: string
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
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.CodeAction[] {
    const findings = findingsCache.get(document.uri.toString()) ?? [];
    const cwd = vscode.Uri.joinPath(vscode.Uri.file(document.fileName), "..").fsPath;
    const actions: vscode.CodeAction[] = [];

    for (const finding of findings) {
      const pkgRange = findPackageRange(document.getText(), document, finding.packageName);
      if (!pkgRange?.intersection(range)) continue;

      const action = new vscode.CodeAction(
        `Fix ${finding.packageName} (${finding.cveId}) with Autoremediator`,
        vscode.CodeActionKind.QuickFix
      );
      action.command = {
        command: "autoremediator.fixCve",
        title: "Fix with Autoremediator",
        arguments: [finding.cveId, cwd],
      };
      actions.push(action);
    }

    return actions;
  }
}
