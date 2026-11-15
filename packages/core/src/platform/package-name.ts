/**
 * An npm package name: an optional `@scope/`, then letters, digits and `. _ ~ -`, never starting with a
 * dot or underscore. Upper-case letters are accepted because old packages on the registry have them
 * (`JSONStream`). Nothing that could change a URL path (`/` beyond the scope separator, `..`, `%`, `?`,
 * `#`, whitespace) passes, so a name is safe to put in a registry path or under `node_modules/`.
 */
export const PACKAGE_NAME_PATTERN = /^(?:@[a-zA-Z0-9~-][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9~-][a-zA-Z0-9._~-]*$/;

export const PACKAGE_NAME_MAX_LENGTH = 214;

export function isValidPackageName(name: string): boolean {
  return name.length <= PACKAGE_NAME_MAX_LENGTH && PACKAGE_NAME_PATTERN.test(name);
}

export function assertValidPackageName(name: string): string {
  if (!isValidPackageName(name)) {
    throw new Error(`${JSON.stringify(name.slice(0, 80))} is not a valid npm package name.`);
  }
  return name;
}
