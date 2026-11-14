import { randomInt } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const RUN_ID = /^run_[0-9a-z]{20}$/;
const PLAN_ID = /^plan_[0-9a-f]{16}$/;
const ATTEMPT_ID = /^attempt_[0-9a-z]{12}$/;

export function newRunId(): string {
  return `run_${Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
}

export const isRunId = (value: unknown): value is string =>
  typeof value === "string" && RUN_ID.test(value);

export const isPlanId = (value: unknown): value is string =>
  typeof value === "string" && PLAN_ID.test(value);

export function newAttemptId(): string {
  return `attempt_${Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
}

export const isAttemptId = (value: unknown): value is string =>
  typeof value === "string" && ATTEMPT_ID.test(value);
