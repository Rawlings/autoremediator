import assert from "node:assert/strict";
import test from "node:test";

import { render, summarise } from "../src/report.ts";

const orders = [
  { customer: "zed", total: 30 },
  { customer: "amy", total: 10 },
  { customer: "amy", total: 5 },
];

test("groups orders by customer, sorted by name", () => {
  assert.deepEqual(summarise(orders), [
    { customer: "amy", orders: 2, total: 15 },
    { customer: "zed", orders: 1, total: 30 },
  ]);
});

test("renders one line per customer", () => {
  assert.equal(render(orders), "amy: 2 orders, 15 total\nzed: 1 orders, 30 total");
});
