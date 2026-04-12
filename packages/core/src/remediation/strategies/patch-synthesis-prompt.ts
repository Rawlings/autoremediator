export interface BuildPatchPromptParams {
  cveId: string;
  packageName: string;
  vulnerableVersion: string;
  vulnerabilityCategory: string;
  cveSummary: string;
  sourceFiles: Record<string, string>;
  modelPersonality: string | undefined;
}

const VULNERABILITY_DESCRIPTIONS: Record<string, string> = {
  redos:
    "Regular Expression Denial of Service (ReDoS): The vulnerability is caused by poorly constructed regular expressions that cause excessive backtracking when processing certain inputs. The fix should optimize the regex to avoid catastrophic backtracking or replace it with a safer alternative.",
  "code-injection":
    "Code Injection: The vulnerability allows injected code to be executed. The fix must properly sanitize/validate inputs and prevent dynamic code execution, or use safe alternatives like template literals with proper escaping.",
  "path-traversal":
    "Path Traversal: The vulnerability allows access to files outside intended directories through path traversal sequences (../, etc.). The fix must validate and normalize file paths, use path.resolve() and path.relative() checks.",
  unknown:
    "Unknown vulnerability type: Analyze the CVE summary carefully and implement the most appropriate fix for the security issue described.",
};

export function buildPatchPrompt(params: BuildPatchPromptParams): string {
  const {
    cveId,
    packageName,
    vulnerableVersion,
    vulnerabilityCategory,
    cveSummary,
    sourceFiles,
    modelPersonality,
  } = params;

  const sourceContext = Object.entries(sourceFiles)
    .map(([filePath, content]) => `\n### File: ${filePath}\n\`\`\`typescript\n${content}\n\`\`\``)
    .join("\n");

  const vulnerabilityContext =
    VULNERABILITY_DESCRIPTIONS[vulnerabilityCategory] ||
    VULNERABILITY_DESCRIPTIONS.unknown;

  const personalityDirective =
    modelPersonality === "analytical"
      ? "Provide concise analysis with explicit risk tradeoffs."
      : modelPersonality === "pragmatic"
        ? "Prioritize minimal, safe changes with low operational risk."
        : "Balance analytical explanation with practical remediation.";

  return `You are a security expert tasked with analyzing a CVE vulnerability and generating a secure patch.

## CVE Information
- CVE ID: ${cveId}
- Package: ${packageName}@${vulnerableVersion}
- Category: ${vulnerabilityCategory}

## Vulnerability Summary
${cveSummary}

## Vulnerability Type Context
${vulnerabilityContext}

## Model Behavior
${personalityDirective}

## Vulnerable Source Code
${sourceContext}

## Your Task
Analyze the source code to:
1. Identify the exact code location causing the vulnerability
2. Explain the root cause of the security issue
3. Propose a secure fix that addresses the vulnerability
4. Provide the complete fixed version of affected files

## Response Format
Respond ONLY with valid JSON (no markdown, no extra text):
{
  "analysis": "Detailed explanation of the vulnerability root cause and why it's a security issue",
  "fixedCode": {
    "path/to/file.js": "Complete fixed source code for this file",
    "path/to/other.ts": "Complete fixed source code for this file"
  },
  "confidence": 0.95,
  "riskLevel": "medium"
}

Important:
- confidence: number between 0 and 1 indicating how confident you are in the fix
- riskLevel: "low", "medium", or "high" - assess the risk of the proposed fix breaking functionality
- fixedCode: must contain the COMPLETE file contents (not just diffs), with the vulnerability addressed
- Only include files that need modification`;
}