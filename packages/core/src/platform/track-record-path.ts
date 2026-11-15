/**
 * Where the earned-autonomy track record lives, relative to the project root. It is the one file
 * under `.autoremediator/` that is meant to be committed, and Autoremediator itself appends to it,
 * so rollback must never put it back to an earlier state (that would erase history) and the scope
 * check must tell it apart from changes an agent made.
 */
export const TRACK_RECORD_PATH = ".autoremediator/track-record.json";
