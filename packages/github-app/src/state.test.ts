import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileAppStateStore, createInMemoryAppStateStore } from "./state.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("app state store", () => {
  it("evicts old deliveries in memory", () => {
    const store = createInMemoryAppStateStore(2);
    store.markDeliveryProcessed("d1");
    store.markDeliveryProcessed("d2");
    store.markDeliveryProcessed("d3");

    expect(store.hasProcessedDelivery("d1")).toBe(false);
    expect(store.hasProcessedDelivery("d2")).toBe(true);
    expect(store.hasProcessedDelivery("d3")).toBe(true);
  });

  it("persists deliveries and installations across reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autoremediator-ghapp-state-"));
    tempDirs.push(dir);

    const writer = createFileAppStateStore(dir, 10);
    writer.markDeliveryProcessed("delivery-xyz");
    writer.markInstallationActive(101);

    const reader = createFileAppStateStore(dir, 10);
    expect(reader.hasProcessedDelivery("delivery-xyz")).toBe(true);
    expect(reader.isInstallationActive(101)).toBe(true);

    reader.markInstallationInactive(101);
    const reader2 = createFileAppStateStore(dir, 10);
    expect(reader2.isInstallationActive(101)).toBe(false);
  });
});
