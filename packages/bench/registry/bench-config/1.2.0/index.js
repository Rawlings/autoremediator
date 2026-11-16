export function createConfig(values) {
  return {
    get(key) {
      return values[key];
    },
  };
}
