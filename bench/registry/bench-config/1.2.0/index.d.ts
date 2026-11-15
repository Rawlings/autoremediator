export interface Config {
  get(key: string): string | undefined;
}
export function createConfig(values: Record<string, string>): Config;
