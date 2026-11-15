// Synthetic package. The backtracking pattern below stands in for a ReDoS advisory.
export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/(\s|[^a-z0-9])+/g, "-")
    .replace(/^-+|-+$/g, "");
}
