import { createHash } from "node:crypto";

/** Hex SHA-256 of a string or bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
