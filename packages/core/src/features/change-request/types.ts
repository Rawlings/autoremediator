export const CHANGE_REQUEST_PROVIDER_VALUES = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
] as const;

export type ChangeRequestProvider = (typeof CHANGE_REQUEST_PROVIDER_VALUES)[number];

export type ChangeRequestGrouping = "all" | "per-cve" | "per-package" | "by-severity";

export interface ChangeRequestOptions {
  enabled?: boolean;
  provider: ChangeRequestProvider;
  grouping?: ChangeRequestGrouping;
  repository?: string;
  baseBranch?: string;
  branchPrefix?: string;
  titlePrefix?: string;
  bodyFooter?: string;
  draft?: boolean;
  pushRemote?: string;
  tokenEnvVar?: string;
  token?: string;
  githubApiUrl?: string;
}

export interface ChangeRequestResult {
  provider: ChangeRequestProvider;
  grouping: ChangeRequestGrouping;
  repository?: string;
  branchName: string;
  title: string;
  body: string;
  created: boolean;
  /** The branch already existed from an earlier run for the same findings and was updated. */
  updated?: boolean;
  draft?: boolean;
  url?: string;
  cveIds: string[];
  packageNames: string[];
  error?: string;
}
