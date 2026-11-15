/** A path with forward slashes, so output does not depend on the platform. */
export function toPosix(path: string): string {
  return path.split("\\").join("/");
}
