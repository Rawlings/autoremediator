/**
 * The autoremediator release the extension runs when the project has no copy of its own. Pinned, not
 * `latest`: this download runs on opening a workspace, with the user's environment. A test keeps it
 * equal to the core package's version.
 */
export const CLI_VERSION = "0.24.0";
