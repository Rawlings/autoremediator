import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How far one pull request has got with the bot PR doctor. */
export interface DoctorRecord {
  /** Attempts reserved so far. */
  attempts: number;
  /** Head commit the latest attempt was made for; the same commit is never attempted twice. */
  lastSha: string;
  /** Whether the "limit reached" comment has been posted. */
  announced: boolean;
}

export type DoctorReservation =
  | { outcome: "granted"; attempt: number }
  /** This head commit already has an attempt (several checks fail at once, or a redelivery). */
  | { outcome: "duplicate" }
  | { outcome: "limit"; /** True only the first time, so the limit is announced once. */ announce: boolean };

export type RemediationMode = "plan" | "fix";

interface StateData {
  schemaVersion: 1;
  deliveries: string[];
  installations: Record<string, "active" | "inactive">;
  doctor?: Record<string, DoctorRecord>;
  modes?: Record<string, RemediationMode>;
  notices?: string[];
}

/** Counters and modes are kept for the most recent pull requests and advisories only. */
const MAX_TRACKED_KEYS = 2000;

export interface AppStateStore {
  hasProcessedDelivery(deliveryId: string): boolean;
  markDeliveryProcessed(deliveryId: string): void;
  isInstallationActive(installationId: number): boolean;
  markInstallationActive(installationId: number): void;
  markInstallationInactive(installationId: number): void;
  /**
   * Take one bot PR doctor attempt for a pull request (`owner/repo#number`) at a head commit.
   * Attempts are counted here, in the state store, so a restart does not reset the cap.
   */
  reserveDoctorAttempt(prKey: string, headSha: string, maxAttempts: number): DoctorReservation;
  /** Remember how an advisory was last run in a repository, so `retry` can run it the same way. */
  recordRemediationMode(key: string, mode: RemediationMode): void;
  getRemediationMode(key: string): RemediationMode | undefined;
  /**
   * Take the right to post a one-off notice (for example "you need write access" on a thread).
   * Returns true the first time a key is claimed and false afterwards, for as long as the store
   * remembers it, so a notice is not repeated for every comment.
   */
  claimNotice(key: string): boolean;
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  // Re-insert so the most recently used keys are the last to be evicted.
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export class InMemoryAppStateStore implements AppStateStore {
  protected readonly deliveries = new Set<string>();
  protected readonly deliveryOrder: string[] = [];
  protected readonly installations = new Map<number, "active" | "inactive">();
  protected readonly doctor = new Map<string, DoctorRecord>();
  protected readonly modes = new Map<string, RemediationMode>();
  protected readonly notices = new Map<string, true>();

  private readonly maxTrackedDeliveries: number;

  public constructor(maxTrackedDeliveries: number = 1000) {
    this.maxTrackedDeliveries = maxTrackedDeliveries;
  }

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

  public reserveDoctorAttempt(
    prKey: string,
    headSha: string,
    maxAttempts: number,
  ): DoctorReservation {
    const record = this.doctor.get(prKey);
    if (record?.lastSha === headSha) {
      return { outcome: "duplicate" };
    }

    const attempts = record?.attempts ?? 0;
    if (attempts >= maxAttempts) {
      const announce = !record?.announced;
      remember(this.doctor, prKey, { attempts, lastSha: headSha, announced: true });
      return { outcome: "limit", announce };
    }

    remember(this.doctor, prKey, {
      attempts: attempts + 1,
      lastSha: headSha,
      announced: false,
    });
    return { outcome: "granted", attempt: attempts + 1 };
  }

  public recordRemediationMode(key: string, mode: RemediationMode): void {
    remember(this.modes, key, mode);
  }

  public getRemediationMode(key: string): RemediationMode | undefined {
    return this.modes.get(key);
  }

  public claimNotice(key: string): boolean {
    if (this.notices.has(key)) return false;
    remember(this.notices, key, true);
    return true;
  }

  /** Restore saved records without changing their order or applying the cap logic again. */
  public restore(data: Pick<StateData, "doctor" | "modes" | "notices">): void {
    for (const [key, record] of Object.entries(data.doctor ?? {})) {
      if (
        record &&
        typeof record === "object" &&
        Number.isInteger(record.attempts) &&
        record.attempts >= 0 &&
        typeof record.lastSha === "string"
      ) {
        remember(this.doctor, key, {
          attempts: record.attempts,
          lastSha: record.lastSha,
          announced: record.announced,
        });
      }
    }
    for (const [key, mode] of Object.entries(data.modes ?? {})) {
      if (mode === "plan" || mode === "fix") remember(this.modes, key, mode);
    }
    for (const key of data.notices ?? []) {
      if (typeof key === "string") remember(this.notices, key, true);
    }
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
      ...(this.doctor.size > 0 ? { doctor: Object.fromEntries(this.doctor) } : {}),
      ...(this.modes.size > 0 ? { modes: Object.fromEntries(this.modes) } : {}),
      ...(this.notices.size > 0 ? { notices: [...this.notices.keys()] } : {}),
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

  public reserveDoctorAttempt(
    prKey: string,
    headSha: string,
    maxAttempts: number,
  ): DoctorReservation {
    const reservation = this.inMemory.reserveDoctorAttempt(prKey, headSha, maxAttempts);
    // Persist before the caller acts: a crash after a push must not forget the attempt.
    this.persist();
    return reservation;
  }

  public recordRemediationMode(key: string, mode: RemediationMode): void {
    this.inMemory.recordRemediationMode(key, mode);
    this.persist();
  }

  public getRemediationMode(key: string): RemediationMode | undefined {
    return this.inMemory.getRemediationMode(key);
  }

  public claimNotice(key: string): boolean {
    const claimed = this.inMemory.claimNotice(key);
    if (claimed) this.persist();
    return claimed;
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

    if (parsed?.schemaVersion !== 1) {
      return;
    }

    const deliveries = Array.isArray(parsed.deliveries) ? parsed.deliveries : [];
    for (const deliveryId of deliveries) {
      if (typeof deliveryId === "string" && deliveryId.length > 0) {
        this.inMemory.markDeliveryProcessed(deliveryId);
      }
    }

    this.inMemory.restore({
      doctor:
        parsed.doctor && typeof parsed.doctor === "object" && !Array.isArray(parsed.doctor)
          ? parsed.doctor
          : undefined,
      modes:
        parsed.modes && typeof parsed.modes === "object" && !Array.isArray(parsed.modes)
          ? parsed.modes
          : undefined,
      notices: Array.isArray(parsed.notices) ? parsed.notices : undefined,
    });

    const installations =
      parsed.installations && typeof parsed.installations === "object"
        ? Object.entries(parsed.installations)
        : [];
    for (const [installationId, state] of installations) {
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

export function createFileAppStateStore(
  dataDir: string,
  maxTrackedDeliveries?: number,
): AppStateStore {
  return new FileAppStateStore(dataDir, maxTrackedDeliveries ?? 1000);
}
