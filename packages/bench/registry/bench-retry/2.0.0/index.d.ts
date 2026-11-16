export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
}
export function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
