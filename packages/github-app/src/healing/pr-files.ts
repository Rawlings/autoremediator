import type { Octokit } from "@octokit/rest";

const PER_PAGE = 100;
/** A pull request that touches more files than this is not one a repair should be guessing about. */
const MAX_PAGES = 3;

/**
 * The paths a pull request itself adds or modifies, as GitHub lists them. A repair may only edit
 * these: everything else in the repository is code the pull request's author did not touch, and
 * the CI output that asks for an edit is text any process in the job can print.
 */
export async function listPullRequestChangedFiles(
  octokit: Octokit,
  ref: { owner: string; repo: string; pullNumber: number },
): Promise<Set<string>> {
  const files = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await octokit.pulls.listFiles({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pullNumber,
      per_page: PER_PAGE,
      page,
    });
    for (const file of data) {
      if (file.status !== "removed") files.add(file.filename);
    }
    if (data.length < PER_PAGE) break;
  }
  return files;
}
