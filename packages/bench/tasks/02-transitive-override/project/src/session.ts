import { cookieHeader } from "bench-http-client";

export const sessionHeader = (id: string): string => cookieHeader({ sid: id, theme: "dark" });
