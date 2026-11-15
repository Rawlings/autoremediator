export function serialize(name, value) {
  return `${name}=${encodeURIComponent(value)}`;
}
