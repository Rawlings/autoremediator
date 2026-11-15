export async function retry(fn, attempts, delayMs) {
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
