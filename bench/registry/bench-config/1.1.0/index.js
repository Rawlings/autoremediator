export function createConfig(values) {
  return {
    get(key) {
      const value = values[key];
      if (value === undefined) throw new Error(`missing config key: ${key}`);
      return value;
    },
  };
}
