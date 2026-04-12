import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface StateData {
  schemaVersion: 1;
  deliveries: string[];
  installations: Record<string, "active" | "inactive">;
}

const DEFAULT_STATE: StateData = {
  schemaVersion: 1,
  deliveries: [],
  installations: {},
};

export interface AppStateStore {
  hasProcessedDelivery(deliveryId: string): boolean;
  markDeliveryProcessed(deliveryId: string): void;
  isInstallationActive(installationId: number): boolean;
  markInstallationActive(installationId: number): void;
  markInstallationInactive(installationId: number): void;
}

export class InMemoryAppStateStore implements AppStateStore {
  protected readonly deliveries = new Set<string>();
  protected readonly deliveryOrder: string[] = [];
  protected readonly installations = new Map<number, "active" | "inactive">();

  public constructor(private readonly maxTrackedDeliveries: number = 1000) {}

  public hasProcessedDelivery(deliveryId: string): boolean {
    return this.deliveries.has(deliveryId);
  }

  public markDeliveryProcessed(deliveryId: string): void {
    if (this.deliveries.has(deliveryId)) {
      return;
    }

    this.deliveries.add(deliveryId);
    this.deliveryOrder.push(deliveryId);

    while (this.deliveryOrder.length > this.maxTrackedDeliveries) {
      const oldest = this.deliveryOrder.shift();
      if (!oldest) {
        break;
      }
      this.deliveries.delete(oldest);
    }
  }

  public isInstallationActive(installationId: number): boolean {
    return this.installations.get(installationId) === "active";
  }

  public markInstallationActive(installationId: number): void {
    this.installations.set(installationId, "active");
  }

  public markInstallationInactive(installationId: number): void {
    this.installations.set(installationId, "inactive");
  }

  public snapshot(): StateData {
    const installations: Record<string, "active" | "inactive"> = {};
    for (const [installationId, state] of this.installations.entries()) {
      installations[String(installationId)] = state;
    }

    return {
      schemaVersion: 1,
      deliveries: [...this.deliveryOrder],
      installations,
    };
  }
}

export class FileAppStateStore implements AppStateStore {
  private readonly inMemory: InMemoryAppStateStore;
  private readonly stateFilePath: string;

  public constructor(dataDir: string, maxTrackedDeliveries: number = 1000) {
    this.inMemory = new InMemoryAppStateStore(maxTrackedDeliveries);
    this.stateFilePath = join(dataDir, "github-app-state.json");
    this.hydrateFromDisk();
  }

  public hasProcessedDelivery(deliveryId: string): boolean {
    return this.inMemory.hasProcessedDelivery(deliveryId);
  }

  public markDeliveryProcessed(deliveryId: string): void {
    this.inMemory.markDeliveryProcessed(deliveryId);
    this.persist();
  }

  public isInstallationActive(installationId: number): boolean {
    return this.inMemory.isInstallationActive(installationId);
  }

  public markInstallationActive(installationId: number): void {
    this.inMemory.markInstallationActive(installationId);
    this.persist();
  }

  public markInstallationInactive(installationId: number): void {
    this.inMemory.markInstallationInactive(installationId);
    this.persist();
  }

  private hydrateFromDisk(): void {
    if (!existsSync(this.stateFilePath)) {
      return;
    }

    let parsed: StateData | undefined;
    try {
      parsed = JSON.parse(readFileSync(this.stateFilePath, "utf8")) as StateData;
    } catch {
      return;
    }

    if (!parsed || parsed.schemaVersion !== 1) {
      return;
    }

    for (const deliveryId of parsed.deliveries) {
      if (typeof deliveryId === "string" && deliveryId.length > 0) {
        this.inMemory.markDeliveryProcessed(deliveryId);
      }
    }

    for (const [installationId, state] of Object.entries(parsed.installations)) {
      const id = Number.parseInt(installationId, 10);
      if (!Number.isFinite(id)) {
        continue;
      }

      if (state === "active") {
        this.inMemory.markInstallationActive(id);
      }

      if (state === "inactive") {
        this.inMemory.markInstallationInactive(id);
      }
    }
  }

  private persist(): void {
    const snapshot = this.inMemory.snapshot();
    const dir = dirname(this.stateFilePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.stateFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

export function createInMemoryAppStateStore(maxTrackedDeliveries?: number): AppStateStore {
  return new InMemoryAppStateStore(maxTrackedDeliveries ?? 1000);
}

export function createFileAppStateStore(dataDir: string, maxTrackedDeliveries?: number): AppStateStore {
  return new FileAppStateStore(dataDir, maxTrackedDeliveries ?? 1000);
}