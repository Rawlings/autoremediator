import { createInterface } from "node:readline/promises";

/** Asking the person at the terminal a yes/no question. */
export async function confirmInteractively(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
