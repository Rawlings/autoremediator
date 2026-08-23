import * as vscode from "vscode";
import { existsSync, readFileSync } from "node:fs";

export const PATCH_SCHEME = "autoremediator-patch";

/**
 * TextDocumentContentProvider for virtual patch previews in VS Code.
 * Allows developers to preview isolated .patch contents before applying to disk.
 */
export class PatchDiffProvider implements vscode.TextDocumentContentProvider {
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const fsPath = uri.fsPath;
    if (!existsSync(fsPath)) {
      return `// Patch artifact not found at: ${fsPath}`;
    }
    try {
      return readFileSync(fsPath, "utf8");
    } catch (err: unknown) {
      return `// Failed to load patch artifact: ${(err as Error).message}`;
    }
  }

  refresh(uri: vscode.Uri): void {
    this.onDidChangeEmitter.fire(uri);
  }
}
