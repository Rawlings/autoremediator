import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: string;
}

function readPackageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const metadata = JSON.parse(raw) as PackageMetadata;

  if (!metadata.version) {
    throw new Error("packages/core/package.json is missing a version field.");
  }

  return metadata.version;
}

export const PACKAGE_VERSION = readPackageVersion();