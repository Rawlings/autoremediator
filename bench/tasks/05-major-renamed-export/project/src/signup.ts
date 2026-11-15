import { check } from "bench-validate";

export const validUsername = (name: string): boolean =>
  check(name, { minLength: 3, pattern: /^[a-z0-9_]+$/ });
