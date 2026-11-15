import YAML from "yaml";

/**
 * The project's lockfile content from a `pnpm-lock.yaml`. pnpm 11 and later write TWO YAML
 * documents: a short leading one for pnpm itself (`packageManagerDependencies`), then the project's.
 * Parsing the file as a single document throws on that, so every document is parsed and the last
 * one that looks like a lockfile is used. Older, single-document files come out unchanged.
 */
export function parsePnpmLockDocument(content: string): unknown {
  const documents = YAML.parseAllDocuments(content)
    .filter((document) => document.errors.length === 0)
    .map((document) => document.toJS() as unknown);
  const lockfiles = documents.filter(
    (value) => value !== null && typeof value === "object" && "lockfileVersion" in value,
  );
  return lockfiles.at(-1) ?? documents.at(-1);
}
