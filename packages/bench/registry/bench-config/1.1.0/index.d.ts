export interface Config {
  get(key: string): string;
}
export function createConfig(values: Record<string, string>): Config;
