// 1.2.3: the pattern no longer backtracks. Behaviour is unchanged.
export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
