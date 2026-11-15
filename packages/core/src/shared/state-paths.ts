/**
 * Paths of the files Autoremediator keeps under `.autoremediator/` that are meant to be committed.
 */

/**
 * Where the earned-autonomy track record lives, relative to the project root. It is the one file
 * under `.autoremediator/` that is meant to be committed, and Autoremediator itself appends to it,
 * so rollback must never put it back to an earlier state (that would erase history) and the scope
 * check must tell it apart from changes an agent made.
 */
export const TRACK_RECORD_PATH = ".autoremediator/track-record.json";

/**
 * Where remediation memory lives, relative to the project root. Like the autonomy track record it
 * is meant to be committed and Autoremediator itself appends to it, so a rollback must never put it
 * back to an earlier state and the scope check must tell it apart from changes an agent made.
 */
export const MEMORY_PATH = ".autoremediator/memory.md";
