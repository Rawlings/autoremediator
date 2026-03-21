export { lookupCveOsv, fetchOsvVuln, parseOsvVuln } from "./sources/osv.js";
export {
  lookupCveGitHub,
  fetchGhAdvisories,
  parseGhAdvisories,
  mergeGhDataIntoCveDetails,
} from "./sources/github-advisory.js";
export { enrichWithNvd, fetchNvdCvss } from "./sources/nvd.js";
export { enrichWithCisaKev, fetchCisaKevFeed, findKevEntry } from "./sources/cisa-kev.js";
export { enrichWithEpss, fetchEpss } from "./sources/epss.js";
export { enrichWithCveServices, fetchCveServicesRecord } from "./sources/cve-services.js";
export { enrichWithGitLabAdvisory, fetchGitLabAdvisories } from "./sources/gitlab-advisory.js";
export { enrichWithCertCc, findCertCcReference } from "./sources/certcc.js";
export { enrichWithDepsDev } from "./sources/deps-dev.js";
export { enrichWithOssfScorecard } from "./sources/ossf-scorecard.js";
export { enrichWithExternalFeeds } from "./sources/external-feeds.js";
export {
  findSafeUpgradeVersion,
  fetchPackageVersions,
  getTarballUrl,
} from "./sources/registry.js";
