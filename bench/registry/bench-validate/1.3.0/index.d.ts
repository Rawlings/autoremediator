export interface Rules {
  minLength?: number;
  pattern?: RegExp;
}
export function check(value: string, rules: Rules): boolean;
