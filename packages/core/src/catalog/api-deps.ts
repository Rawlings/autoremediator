import {
  checkReachability,
  evaluatePackage,
  inspectPatchArtifact,
  listPatchArtifacts,
  planRemediation,
  pollJob,
  remediate,
  remediateFromScan,
  remediatePortfolio,
  scanDelta,
  submitPortfolioJob,
  submitRemediateJob,
  submitScanJob,
  toCycloneDxVex,
  updateOutdated,
  validatePatchArtifact,
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
  healthFn: () => Promise<{ status: "ok" }>;
  listPatchArtifactsFn: typeof listPatchArtifacts;
  inspectPatchArtifactFn: typeof inspectPatchArtifact;
  validatePatchArtifactFn: typeof validatePatchArtifact;
  toVexFn: typeof toCycloneDxVex;
  submitRemediateJobFn: typeof submitRemediateJob;
  submitScanJobFn: typeof submitScanJob;
  submitPortfolioJobFn: typeof submitPortfolioJob;
  pollJobFn: typeof pollJob;
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
  healthFn: async () => ({ status: "ok" }),
  listPatchArtifactsFn: listPatchArtifacts,
  inspectPatchArtifactFn: inspectPatchArtifact,
  validatePatchArtifactFn: validatePatchArtifact,
  toVexFn: toCycloneDxVex,
  submitRemediateJobFn: submitRemediateJob,
  submitScanJobFn: submitScanJob,
  submitPortfolioJobFn: submitPortfolioJob,
  pollJobFn: pollJob,
};
