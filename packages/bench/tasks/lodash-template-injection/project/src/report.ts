import _ from "lodash";

export interface Order {
  customer: string;
  total: number;
}

export interface CustomerSummary {
  customer: string;
  orders: number;
  total: number;
}

const lineTemplate = _.template("<%= customer %>: <%= orders %> orders, <%= total %> total");

/** One row per customer, sorted by name. */
export function summarise(orders: Order[]): CustomerSummary[] {
  return _.sortBy(
    _.map(_.groupBy(orders, "customer"), (list, customer) => ({
      customer,
      orders: list.length,
      total: _.sumBy(list, "total"),
    })),
    "customer",
  );
}

export function render(orders: Order[]): string {
  return summarise(orders)
    .map((summary) => lineTemplate(summary))
    .join("\n");
}
