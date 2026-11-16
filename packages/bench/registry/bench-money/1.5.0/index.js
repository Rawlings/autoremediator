export function format(cents, options = {}) {
  const separator = options.separator ?? "\u202f";
  const [whole, fraction] = (cents / 100).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, separator)}.${fraction}`;
}
