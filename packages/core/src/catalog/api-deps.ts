import {
  abandonAttempt,
  bisectLockfile,
  getAutonomy,
  analyzeDependencies,
  removeUnusedDependencies,
  applyPlan,
  applyRecipe,
  assessUpgrade,
  checkReachability,
  evaluatePackage,
  finalizeAttempt,
  findVulnerableSymbols,
  getRun,
  guardPackage,
  init,
  installHooks,
  incident,
  inspectPatchArtifact,
  listPatchArtifacts,
  listRecipes,
  listRuns,
  planRemediation,
  pollJob,
  premortem,
  proposePatch,
  reconcilePatchArtifacts,
  remediate,
  remediateFromScan,
  remediatePortfolio,
  resumeRun,
  rollbackRun,
  scanDelta,
  startAttempt,
  submitPortfolioJob,
  submitRemediateJob,
  submitScanJob,
  toCycloneDxVex,
  updateOutdated,
  validatePatchArtifact,
  verifyAttempt,
  verifyRun,
  compilePolicy,
  explainPolicy,
  maintain,
  readMaintainerVex,
} from "../api/index.js";

/** The SDK functions operations call. Injectable so tests and embedders can substitute them. */
export interface ApiDeps {
  remediateFn: typeof remediate;
  planRemediationFn: typeof planRemediation;
  remediateFromScanFn: typeof remediateFromScan;
  remediatePortfolioFn: typeof remediatePortfolio;
  updateOutdatedFn: typeof updateOutdated;
  checkReachabilityFn: typeof checkReachability;
  evaluatePackageFn: typeof evaluatePackage;
  scanDeltaFn: typeof scanDelta;
  initFn: typeof init;
  installHooksFn: typeof installHooks;
  guardPackageFn: typeof guardPackage;
  healthFn: () => Promise<{ status: "ok" }>;
  listPatchArtifactsFn: typeof listPatchArtifacts;
  inspectPatchArtifactFn: typeof inspectPatchArtifact;
  validatePatchArtifactFn: typeof validatePatchArtifact;
  reconcilePatchArtifactsFn: typeof reconcilePatchArtifacts;
  toVexFn: typeof toCycloneDxVex;
  submitRemediateJobFn: typeof submitRemediateJob;
  submitScanJobFn: typeof submitScanJob;
  submitPortfolioJobFn: typeof submitPortfolioJob;
  pollJobFn: typeof pollJob;
  applyPlanFn: typeof applyPlan;
  resumeRunFn: typeof resumeRun;
  rollbackRunFn: typeof rollbackRun;
  getRunFn: typeof getRun;
  listRunsFn: typeof listRuns;
  verifyRunFn: typeof verifyRun;
  startAttemptFn: typeof startAttempt;
  proposePatchFn: typeof proposePatch;
  verifyAttemptFn: typeof verifyAttempt;
  finalizeAttemptFn: typeof finalizeAttempt;
  abandonAttemptFn: typeof abandonAttempt;
  listRecipesFn: typeof listRecipes;
  applyRecipeFn: typeof applyRecipe;
  bisectLockfileFn: typeof bisectLockfile;
  getAutonomyFn: typeof getAutonomy;
  analyzeDependenciesFn: typeof analyzeDependencies;
  removeUnusedDependenciesFn: typeof removeUnusedDependencies;
  assessUpgradeFn: typeof assessUpgrade;
  findVulnerableSymbolsFn: typeof findVulnerableSymbols;
  incidentFn: typeof incident;
  premortemFn: typeof premortem;
  compilePolicyFn: typeof compilePolicy;
  explainPolicyFn: typeof explainPolicy;
  maintainFn: typeof maintain;
  readMaintainerVexFn: typeof readMaintainerVex;
}

export const defaultApiDeps: ApiDeps = {
  remediateFn: remediate,
  planRemediationFn: planRemediation,
  remediateFromScanFn: remediateFromScan,
  remediatePortfolioFn: remediatePortfolio,
  updateOutdatedFn: updateOutdated,
  checkReachabilityFn: checkReachability,
  evaluatePackageFn: evaluatePackage,
  scanDeltaFn: scanDelta,
  initFn: init,
  installHooksFn: installHooks,
  guardPackageFn: guardPackage,
  healthFn: async () => ({ status: "ok" }),
  listPatchArtifactsFn: listPatchArtifacts,
  inspectPatchArtifactFn: inspectPatchArtifact,
  validatePatchArtifactFn: validatePatchArtifact,
  reconcilePatchArtifactsFn: reconcilePatchArtifacts,
  toVexFn: toCycloneDxVex,
  submitRemediateJobFn: submitRemediateJob,
  submitScanJobFn: submitScanJob,
  submitPortfolioJobFn: submitPortfolioJob,
  pollJobFn: pollJob,
  applyPlanFn: applyPlan,
  resumeRunFn: resumeRun,
  rollbackRunFn: rollbackRun,
  getRunFn: getRun,
  listRunsFn: listRuns,
  verifyRunFn: verifyRun,
  startAttemptFn: startAttempt,
  proposePatchFn: proposePatch,
  verifyAttemptFn: verifyAttempt,
  finalizeAttemptFn: finalizeAttempt,
  abandonAttemptFn: abandonAttempt,
  listRecipesFn: listRecipes,
  applyRecipeFn: applyRecipe,
  bisectLockfileFn: bisectLockfile,
  getAutonomyFn: getAutonomy,
  analyzeDependenciesFn: analyzeDependencies,
  removeUnusedDependenciesFn: removeUnusedDependencies,
  assessUpgradeFn: assessUpgrade,
  findVulnerableSymbolsFn: findVulnerableSymbols,
  incidentFn: incident,
  premortemFn: premortem,
  compilePolicyFn: compilePolicy,
  explainPolicyFn: explainPolicy,
  maintainFn: maintain,
  readMaintainerVexFn: readMaintainerVex,
};
