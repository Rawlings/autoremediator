/**
 * Where remediation memory lives, relative to the project root. Like the autonomy track record it
 * is meant to be committed and Autoremediator itself appends to it, so a rollback must never put it
 * back to an earlier state and the scope check must tell it apart from changes an agent made.
 */
export const MEMORY_PATH = ".autoremediator/memory.md";
