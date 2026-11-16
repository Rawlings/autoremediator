import { serialize } from "bench-cookie";

export function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => serialize(name, value))
    .join("; ");
}
