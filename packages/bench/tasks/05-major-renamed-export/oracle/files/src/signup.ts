import { validate } from "bench-validate";

export const validUsername = (name: string): boolean =>
  validate(name, { minLength: 3, pattern: /^[a-z0-9_]+$/ });
