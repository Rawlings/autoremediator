export function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? "");
}
