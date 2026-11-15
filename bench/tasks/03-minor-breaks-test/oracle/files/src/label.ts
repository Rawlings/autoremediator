import { format } from "bench-money";

export const totalLabel = (cents: number): string => `Total: $${format(cents, { separator: "," })}`;
