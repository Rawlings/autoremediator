import { load } from "bench-yaml";

export const readMode = (text: string): string => load(text)["mode"] ?? "default";
