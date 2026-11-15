import assert from "node:assert/strict";
import test from "node:test";
import { totalLabel } from "../src/label.ts";

test("formats a total with comma separators", () => {
  assert.equal(totalLabel(123450), "Total: $1,234.50");
  assert.equal(totalLabel(99), "Total: $0.99");
});
