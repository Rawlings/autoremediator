// 1.2.3: the pattern no longer backtracks. Behaviour is unchanged.
export function slugify(input) {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === "-") start += 1;
  while (end > start && slug[end - 1] === "-") end -= 1;
  return slug.slice(start, end);
}
