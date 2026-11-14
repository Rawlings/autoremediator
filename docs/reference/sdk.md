# SDK reference

```ts
import { remediate } from "autoremediator";

const report = await remediate("CVE-2021-23337", { cwd: "/path/to/project", dryRun: true });
```

Every function returns a promise unless noted. Option names are identical to the
[CLI flags](cli.md) in camelCase, and to the fields accepted by the
[MCP](../integrations/mcp-server.md) and [HTTP](../integrations/http-server.md) servers.

## Functions

| Function | Returns |
| -------- | ------- |
| `remediate(cveId, options?)` | `RemediationReport` |
| `planRemediation(cveId, options?)` | `RemediationReport` with `runId` and `planId`. Always a dry run; do not pass `dryRun` or `preview`. Records the [plan](../guides/plan-and-apply.md) unless `evidence` is `false` |
| `applyPlan({ runId \| planId, itemIds?, verify?, repair?, model?, repairAgent?, repairBudget?, cwd? })` | `RunReport`: each item's outcome (with `repair` when an agent was asked), the status, what is pending. `repairAgent` plugs in your own [`RepairAgent`](../guides/plan-and-apply.md#repair-with-an-agent) |
| `resumeRun({ runId, cwd? })` | `RunReport` |
| `rollbackRun({ runId, force?, reinstall?, cwd? })` | `RollbackReport` |
| `verifyRun({ runId, checks?, offline?, cwd? })` | `VerificationResult` (plus `runId`): each check's status and details, and the first that failed |
| `getRun({ runId, cwd? })` | `RunDetails`: record, plan, item outcomes, ledger and whether it is intact |
| `listRuns({ status?, limit?, cwd? })` | `RunRecord[]`, newest first |
| `startAttempt({ runId, itemId, cwd? })`, `proposePatch({ runId, attemptId, diff })`, `verifyAttempt({ runId, attemptId, checks? })`, `finalizeAttempt({ runId, attemptId })`, `abandonAttempt({ runId, attemptId })` | `AttemptView`: where to edit, the verifier's findings, whether it was finalized. For [your own agent](../guides/plan-and-apply.md#letting-your-own-agent-do-the-repair) |
| `remediateFromScan(inputPath, options?)` | `ScanReport`. `options.audit` runs the package manager's audit instead |
| `remediatePortfolio(targets, options?)` | `PortfolioReport` |
| `updateOutdated(options?)` | `UpdateOutdatedReport` |
| `init({ cwd?, hosts?, ci?, policy?, agentsMd?, yes?, check? })` | `InitResult`: what was detected, each file's action and diff, `drift`, `applied`, `conflicts`. Writes only with `yes`. See [Coding agents](../integrations/coding-agents.md) |
| `scanDelta({ cwd?, baseRef?, includeUnstaged?, packageManager? })` | `DeltaScanReport` |
| `checkReachability({ packageName, symbol?, cwd? })` | `ReachabilityAssessment` |
| `evaluatePackage(name, { version?, packageManager?, cwd? })` | `PackageEvaluationReport` |
| `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`, `reconcilePatchArtifacts` | Patch artifact reports |
| `submitRemediateJob`, `submitScanJob`, `submitPortfolioJob` (sync) | `{ jobId, status, submittedAt }` |
| `pollJob(jobId)` (sync) | The job: its `status`, and its report as `result` once finished |

Report helpers: `toCiSummary`, `ciExitCode` (returns one of `EXIT_CODES`: `ok` 0, `failed` 1, `partial` 2, `needsApproval` 3, `policyBlocked` 4), `toSarifOutput`, `toCycloneDxVex`.

Jobs run in the same process and are kept in memory only.

## Options

`RemediateOptions` is the shared option type; `ScanOptions` adds `format` and `audit`;
`UpdateOutdatedOptions` adds `includeTransitive`. Fields, with the section that explains each:

| Group | Options |
| ----- | ------- |
| Project | `cwd`, `packageManager`, `policy`, `patchesDir` |
| Verification | `runTests`, `typecheck`, `proofOfFix`, `requireProofOfFix`, `reproductionTest`, `breakingChangeRefactor` |
| Safety | `dryRun`, `preview`, `simulationMode`, `constraints`, `supplyChainPolicy` |
| Intelligence | `offlineIntelligence`, `intelligenceSnapshotPath`, `exploitSignalOverride`, `suppressionsFile`, `slaCheck`, `skipUnreachable` |
| Outcomes | `dispositionPolicy`, `containmentMode`, `escalationGraph`, `campaignMode` |
| Patch generation | `model`, `patchGenerator`, `patchConfidenceThresholds` |
| Output | `evidence`, `changeRequest` |
| Provenance | `requestId`, `sessionId`, `parentRunId`, `actor`, `source`, `idempotencyKey`, `resume` |

Policy keys that are not options (`allowMajorBumps`, `denyPackages`, `allowPackages`, `sla`) live
in the [policy file](policy-file.md), which `policy` points at. It can also be inline YAML or JSON.

The full type definitions ship with the package. Invalid options throw.

## Reports

### `RemediationReport`

| Field | Meaning |
| ----- | ------- |
| `cveId`, `cveDetails` | The advisory and what was found about it |
| `vulnerablePackages` | Installed packages in a vulnerable range |
| `results[]` | One `PatchResult` per package (below) |
| `summary` | One-line summary |
| `sbom[]` | Installed packages with CVEs and `patched`, `unpatched`, `skipped` or `suppressed` status |
| `exploitSignalTriggered`, `slaBreaches` | Prioritization signals |
| `dispositionCounts`, `escalationCounts` | Aggregates over `results` |
| `llmUsage[]` | Model, tokens and latency for patch generation |
| `changeRequests[]` | Pull or merge requests created; `updated` is set when a re-run reused the branch of an earlier one |
| `evidenceFile` | Path of the evidence file |

### `PatchResult`

| Field | Meaning |
| ----- | ------- |
| `packageName`, `fromVersion`, `toVersion` | What changed |
| `strategy` | `version-bump`, `override`, `patch-file`, `breaking-change-refactor` or `none` |
| `applied`, `dryRun` | Whether the project was changed |
| `unresolvedReason` | Why it was not fixed. See [Outcomes](../how-it-works.md#outcomes) |
| `disposition`, `dispositionReason`, `escalationAction` | Classification and follow-up |
| `dependencyScope` | `direct` or `transitive` |
| `confidence`, `riskLevel` | For patches |
| `validation`, `validationPhases` | Install, test and type-check results |
| `proofOfFix` | Proof-of-fix verification result |
| `patchFilePath`, `patchArtifact` | The `.patch` file, for patch results |
| `simulation` | Planned mutations and rebuttal findings, in simulation mode |

### Scan, portfolio and outdated reports

`ScanReport`, `PortfolioReport` and `UpdateOutdatedReport` carry `schemaVersion`, `status` (`ok`,
`partial`, `failed`), `generatedAt`, `successCount` and `failedCount`, plus their children
(`reports[]`, `targets[]`, `outdatedPackages[]`). `ciExitCode` returns `1` when `failedCount` is
above zero.

### Inspection reports

| Function | Report fields |
| -------- | ------------- |
| `evaluatePackage` | `verdict` (`safe`, `caution`, `vulnerable`, `actively-exploited`), `isVulnerable`, `vulnerabilities[]`, `recommendedVersion`, `latestVersion` |
| `scanDelta` | `status` and `netRiskVerdict` (`improved`, `neutral`, `degraded`), `dependencyChanges[]`, `introducedFindings[]`, `resolvedFindings[]` |
| `checkReachability` | `status` (`reachable`, `not-reachable`, `unknown`), `reason`, `reachabilityBasis` |

## Bring your own patch generator

```ts
import { remediate, type PatchGenerator } from "autoremediator";

const patchGenerator: PatchGenerator = {
  async propose(request) {
    // request: cveId, packageName, vulnerableVersion, cveSummary, sourceFiles
    return {
      fixedFiles: { "lib/index.js": "..." }, // complete new contents, keyed by path
      analysis: "What was wrong and what changed",
      confidence: 0.9,
      riskLevel: "low",
    };
  },
};

await remediate("CVE-2021-23337", { patchGenerator });
```

Output goes through the same syntax check and confidence gate as a model's.
`createLlmPatchGenerator` and `resolveLanguageModel` expose the built-in implementation.
