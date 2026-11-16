import { parseFast } from "bench-fastjson";

export const readCount = (text: string): number => (parseFast(text) as { count: number }).count;
