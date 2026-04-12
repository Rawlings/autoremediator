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
} from "../../../platform/config.js";
import { buildPatchPrompt } from "../../strategies/patch-synthesis-prompt.js";
import {
  buildGeneratedPatches,
  isValidLlmAnalysis,
  parseLlmAnalysisResponse,
  type GeneratedPatch,
} from "./helpers.js";

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
    patchConfidenceThresholds: z
      .object({
        low: z.number().min(0).max(1).optional(),
        medium: z.number().min(0).max(1).optional(),
        high: z.number().min(0).max(1).optional(),
      })
      .optional()
      .describe("Optional per-risk confidence thresholds for patch acceptance"),
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
    patchConfidenceThresholds,
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

      const inputChars = JSON.stringify(resolvedSourceFiles).length + cveSummary.length;
      const modelInstance = await createModel(effectiveOptions, { inputChars });
      const modelName = modelInstance.modelId || "unknown-model";

      const prompt = buildPatchPrompt({
        cveId,
        packageName,
        vulnerableVersion,
        vulnerabilityCategory,
        cveSummary,
        sourceFiles: resolvedSourceFiles,
        modelPersonality,
      });

      const started = Date.now();
      const { text } = await generateText({
        model: modelInstance,
        prompt,
        temperature: 0.3,
      });
      const latencyMs = Date.now() - started;

      const parsed = parseLlmAnalysisResponse(text);
      if (!parsed.ok) {
        return {
          success: false,
          llmProvider: provider,
          llmModel: modelName,
          confidence: 0,
          riskLevel: "high",
          latencyMs,
          error: `Failed to parse LLM response: ${parsed.error}`,
        };
      }
      const analysis = parsed.analysis;

      if (!isValidLlmAnalysis(analysis)) {
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
        providerSafetyProfile ?? "relaxed",
        analysis.riskLevel,
        patchConfidenceThresholds
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

      const patches = buildGeneratedPatches(resolvedSourceFiles, analysis.fixedCode);

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