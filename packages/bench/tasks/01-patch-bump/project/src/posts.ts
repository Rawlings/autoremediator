import { slugify } from "bench-slugify";

export const postUrl = (title: string): string => `/posts/${slugify(title)}`;
