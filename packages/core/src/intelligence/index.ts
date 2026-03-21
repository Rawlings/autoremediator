export { lookupCveOsv, fetchOsvVuln, parseOsvVuln } from "./sources/osv.js";
export {
  lookupCveGitHub,
  fetchGhAdvisories,
  parseGhAdvisories,
  mergeGhDataIntoCveDetails,
} from "./sources/github-advisory.js";
export { enrichWithNvd, fetchNvdCvss } from "./sources/nvd.js";
export {
  findSafeUpgradeVersion,
  fetchPackageVersions,
  getTarballUrl,
} from "./sources/registry.js";
