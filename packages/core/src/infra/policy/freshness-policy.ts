import { z } from "zod";

/**
 * How far behind the latest release a direct dependency may fall before `autoremediator freshness`
 * plans a climb. Every limit is optional, but at least one must be set: a `freshness` key that
 * limits nothing is a mistake, not a policy.
 */
export interface FreshnessPolicy {
  /** Most major versions a dependency may trail the latest release by (0 = always on the latest major). */
  maxMajorsBehind?: number;
  /** Most minor versions it may trail by, counted only when it is on the latest major. */
  maxMinorsBehind?: number;
  /** Oldest the installed version may be, in days since it was published, while a newer one exists. */
  maxAgeDays?: number;
  /** Packages left alone: an exact name, `@scope/*`, or a `prefix*`. They do not count in the score. */
  ignore: string[];
}

const limit = z.number().int().min(0);

export const freshnessPolicySchema = z
  .object({
    maxMajorsBehind: limit.optional(),
    maxMinorsBehind: limit.optional(),
    maxAgeDays: z.number().positive().optional(),
    ignore: z.array(z.string().trim().min(1)).default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.maxMajorsBehind !== undefined ||
      value.maxMinorsBehind !== undefined ||
      value.maxAgeDays !== undefined,
    { message: "set at least one of maxMajorsBehind, maxMinorsBehind or maxAgeDays" },
  );

/** Whether `name` is matched by an `ignore` entry. */
export function isIgnoredPackage(ignore: readonly string[], name: string): boolean {
  return ignore.some((pattern) => {
    const entry = pattern.trim();
    if (entry === "*") return true;
    if (entry.endsWith("*")) return name.startsWith(entry.slice(0, -1));
    return entry === name;
  });
}
