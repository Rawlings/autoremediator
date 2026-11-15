export function validate(value, rules) {
  if (rules.minLength !== undefined && value.length < rules.minLength) return false;
  if (rules.pattern !== undefined && !rules.pattern.test(value)) return false;
  return true;
}
