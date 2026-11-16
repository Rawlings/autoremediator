import { parse } from "bench-legacy-xml";

export const feedTitle = (xml: string): string => parse(xml)["title"] ?? "";
