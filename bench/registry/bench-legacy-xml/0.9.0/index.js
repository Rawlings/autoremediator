export function parse(xml) {
  const out = {};
  for (const match of xml.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[match[1]] = match[2];
  return out;
}
