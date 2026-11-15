export interface Rules {
  minLength?: number;
  pattern?: RegExp;
}
export function validate(value: string, rules: Rules): boolean;
