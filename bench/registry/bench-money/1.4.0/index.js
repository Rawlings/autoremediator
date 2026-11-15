export function format(cents) {
  const [whole, fraction] = (cents / 100).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
