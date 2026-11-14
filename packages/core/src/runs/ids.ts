import { randomInt } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const RUN_ID = /^run_[0-9a-z]{20}$/;
const PLAN_ID = /^plan_[0-9a-f]{16}$/;

export function newRunId(): string {
  return `run_${Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
}

export const isRunId = (value: unknown): value is string =>
  typeof value === "string" && RUN_ID.test(value);

export const isPlanId = (value: unknown): value is string =>
  typeof value === "string" && PLAN_ID.test(value);
