export function load(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length > 0) out[key.trim()] = rest.join(":").trim();
  }
  return out;
}
