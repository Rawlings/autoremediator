/**
 * Tool: generate-patch
 *
 * Calls the LLM to analyze vulnerable source code and generate a unified diff patch.
 * Parses LLM response and validates patch format.
 */
import { tool } from "ai";
import { z } from "zod";
import { generateText } from "ai";
import {
  createModel,
  estimateModelCostUsd,
  getPatchConfidenceThreshold,
  resolveProvider,
} from "../../platform/config.js";

/**
 * Represents a single generated patch file.
 */
interface GeneratedPatch {
  filePath: string;
  unifiedDiff: string;
}

/**
 * Result from the patch generation tool.
 */
interface GeneratePatchResult {
  success: boolean;
  patches?: GeneratedPatch[];
  patchContent?: string;
  llmProvider: "remote" | "local";
  llmModel: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  confidenceThreshold?: number;
  error?: string;
}

/**
 * LLM analysis response schema.
 */
interface LlmAnalysis {
  analysis: string;
  fixedCode: Record<string, string>;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
}

/**
 * Vulnerability category descriptions for the LLM.
 */
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

export const generatePatchTool = tool({
  description:
    "Generate a unified diff patch for a CVE using LLM analysis of vulnerable source code.",
  parameters: z.object({
    packageName: z.string().min(1).describe("The npm package name"),
    vulnerableVersion: z
      .string()
      .describe("The vulnerable version string"),
    cveId: z
      .string()
      .regex(/^CVE-\d{4}-\d+$/i)
      .describe("CVE ID (e.g., CVE-2021-23337)"),
    cveSummary: z.string().min(10).describe("CVE description and impact"),
    sourceFiles: z
      .record(z.string())
      .describe(
        "Map of file paths to source code contents from fetch-package-source"
      ),
    vulnerabilityCategory: z
      .enum(["redos", "code-injection", "path-traversal", "unknown"])
      .optional()
      .default("unknown")
      .describe("Category of the vulnerability for better context"),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, return analysis without generating patches"),
    llmProvider: z
      .enum(["remote", "local"])
      .optional()
      .describe("Optional provider override for patch generation"),
    model: z
      .string()
      .optional()
      .describe("Optional model override for patch generation"),
    policy: z
      .string()
      .optional()
      .describe("Optional policy file path for model default resolution"),
    cwd: z
      .string()
      .optional()
      .describe("Optional working directory for policy/model resolution"),
    providerSafetyProfile: z
      .enum(["strict", "relaxed"])
      .optional()
      .describe("Confidence threshold profile for patch acceptance"),
    dynamicModelRouting: z
      .boolean()
      .optional()
      .describe("Enable dynamic model routing by input size"),
    dynamicRoutingThresholdChars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Threshold for dynamic model routing"),
    modelPersonality: z
      .enum(["analytical", "pragmatic", "balanced"])
      .optional()
      .describe("Prompt personality for patch-generation guidance"),
  }),
  execute: async ({
    packageName,
    vulnerableVersion,
    cveId,
    cveSummary,
    sourceFiles,
    vulnerabilityCategory,
    dryRun,
    llmProvider,
    model,
    policy,
    cwd,
    providerSafetyProfile,
    dynamicModelRouting,
    dynamicRoutingThresholdChars,
    modelPersonality,
  }): Promise<GeneratePatchResult> => {
    try {
      const resolvedSourceFiles = sourceFiles;
      const effectiveOptions = {
        llmProvider,
        model,
        policy,
        cwd,
        providerSafetyProfile,
        dynamicModelRouting,
        dynamicRoutingThresholdChars,
        modelPersonality,
      };
      const provider = resolveProvider(effectiveOptions);
      if (Object.keys(resolvedSourceFiles).length === 0) {
        return {
          success: false,
          llmProvider: provider,
          llmModel: "unknown",
          confidence: 0,
          riskLevel: "high",
          error: "No source files were provided. Call fetch-package-source first and pass sourceFiles.",
        };
      }

      // Create LLM model
      const inputChars = JSON.stringify(resolvedSourceFiles).length + cveSummary.length;
      const modelInstance = await createModel(effectiveOptions, { inputChars });
      const modelName = modelInstance.modelId || "unknown-model";

      // Build source files context
      const sourceContext = Object.entries(resolvedSourceFiles)
        .map(([filePath, content]) => `\n### File: ${filePath}\n\`\`\`typescript\n${content}\n\`\`\``)
        .join("\n");

      // Build the LLM prompt
      const vulnerabilityContext =
        VULNERABILITY_DESCRIPTIONS[vulnerabilityCategory] ||
        VULNERABILITY_DESCRIPTIONS.unknown;

      const personalityDirective =
        modelPersonality === "analytical"
          ? "Provide concise analysis with explicit risk tradeoffs."
          : modelPersonality === "pragmatic"
            ? "Prioritize minimal, safe changes with low operational risk."
            : "Balance analytical explanation with practical remediation.";

      const prompt = `You are a security expert tasked with analyzing a CVE vulnerability and generating a secure patch.

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

      // Call LLM
      const started = Date.now();
      const { text } = await generateText({
        model: modelInstance,
        prompt,
        temperature: 0.3, // Lower temperature for more consistent code generation
      });
      const latencyMs = Date.now() - started;

      // Parse LLM response
      let analysis: LlmAnalysis;
      try {
        // Extract JSON from response (in case LLM includes extra text)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error("No JSON found in LLM response");
        }
        analysis = JSON.parse(jsonMatch[0]) as LlmAnalysis;
      } catch (err) {
        return {
          success: false,
          llmProvider: provider,
          llmModel: modelName,
          confidence: 0,
          riskLevel: "high",
          latencyMs,
          error: `Failed to parse LLM response: ${err instanceof Error ? err.message : "unknown error"}`,
        };
      }

      // Validate analysis structure
      if (
        !analysis.analysis ||
        !analysis.fixedCode ||
        typeof analysis.confidence !== "number" ||
        !["low", "medium", "high"].includes(analysis.riskLevel)
      ) {
        return {
          success: false,
          llmProvider: provider,
          llmModel: modelName,
          confidence: 0,
          riskLevel: "high",
          latencyMs,
          error: "LLM response missing required fields (analysis, fixedCode, confidence, riskLevel)",
        };
      }

      const confidenceThreshold = getPatchConfidenceThreshold(
        provider,
        providerSafetyProfile ?? "relaxed"
      );
      const estimatedCostUsd = estimateModelCostUsd({
        provider,
        promptChars: prompt.length,
        completionChars: text.length,
      });

      if (dryRun) {
        return {
          success: true,
          llmProvider: provider,
          llmModel: modelName,
          latencyMs,
          estimatedCostUsd,
          confidenceThreshold,
          confidence: analysis.confidence,
          riskLevel: analysis.riskLevel,
        };
      }

      // Step 3: Generate unified diffs
      const patches: GeneratedPatch[] = [];

      for (const [filePath, fixedCode] of Object.entries(
        analysis.fixedCode
      )) {
        const sourceFile = resolvedSourceFiles[filePath];

        if (!sourceFile) {
          continue; // Skip files not in original source
        }

        // Generate unified diff
        const unifiedDiff = generateUnifiedDiff(
          sourceFile,
          fixedCode,
          filePath
        );

        if (unifiedDiff) {
          patches.push({
            filePath,
            unifiedDiff,
          });
        }
      }

      if (patches.length === 0) {
        return {
          success: false,
          llmProvider: provider,
          llmModel: modelName,
          latencyMs,
          estimatedCostUsd,
          confidenceThreshold,
          confidence: analysis.confidence,
          riskLevel: analysis.riskLevel,
          error: "No valid patches could be generated from LLM response",
        };
      }

      return {
        success: true,
        patches,
        patchContent: patches[0]?.unifiedDiff,
        llmProvider: provider,
        llmModel: modelName,
        latencyMs,
        estimatedCostUsd,
        confidenceThreshold,
        confidence: analysis.confidence,
        riskLevel: analysis.riskLevel,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        success: false,
        llmProvider: "local",
        llmModel: "unknown",
        confidence: 0,
        riskLevel: "high",
        error: `Patch generation failed: ${message}`,
      };
    }
  },
});

/**
 * Generate a unified diff between two strings.
 * Returns a unified diff format or null if there are no differences.
 */
function generateUnifiedDiff(
  original: string,
  fixed: string,
  filePath: string
): string | null {
  if (original === fixed) {
    return null;
  }

  const originalLines = original.split("\n");
  const fixedLines = fixed.split("\n");

  // Simple unified diff generation
  // In a production system, use a library like 'diff' for more accurate diffs
  const diff: string[] = [];
  diff.push(`--- a/${filePath}`);
  diff.push(`+++ b/${filePath}`);
  diff.push("@@ -1," + originalLines.length + " +1," + fixedLines.length + " @@");

  // Find longest common subsequence for better diff
  // For now, simple line-by-line comparison
  const maxLen = Math.max(originalLines.length, fixedLines.length);

  for (let i = 0; i < maxLen; i++) {
    const origLine = originalLines[i] || "";
    const fixedLine = fixedLines[i] || "";

    if (origLine !== fixedLine) {
      if (origLine) {
        diff.push("-" + origLine);
      }
      if (fixedLine) {
        diff.push("+" + fixedLine);
      }
    } else if (origLine) {
      diff.push(" " + origLine);
    }
  }

  return diff.join("\n");
}
