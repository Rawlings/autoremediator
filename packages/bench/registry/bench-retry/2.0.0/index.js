export async function retry(fn, options = {}) {
  const { attempts = 1, delayMs = 0 } = options;
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw last;
}
