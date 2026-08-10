import type { CompanionSettings, Freshness, VehicleSnapshot, WidgetParameter } from "./domain"
import { makeDemoSnapshot } from "./fixtures"

const SHARED = { shared: true }
const SNAPSHOT_KEY = "bmw.companion.v2.snapshot.demo-bmw-i4"
const NETWORK_SNAPSHOT_KEY = "bmw.companion.v2.snapshot.connected"
const WIDGET_SNAPSHOT_KEY = "bmw.companion.v2.snapshot.widget-projection"
const RUNTIME_MODE_KEY = "bmw.companion.v2.runtimeMode"
const SETTINGS_KEY = "bmw.companion.v2.settings"
const WIDGET_RELOAD_KEY = "bmw.companion.v2.widget.lastReloadAt"

export const defaultSettings: CompanionSettings = {
  schemaVersion: 1,
  privacyMode: false,
  freshnessMinutes: 15,
  staleHours: 6,
  defaultVehicleId: "demo-bmw-i4",
  selectedVin: "",
}

export function loadSettings(): CompanionSettings {
  const value = Storage.get<CompanionSettings>(SETTINGS_KEY, SHARED)
  if (!value || value.schemaVersion !== 1) {
    Storage.set(SETTINGS_KEY, defaultSettings, SHARED)
    return defaultSettings
  }
  return { ...defaultSettings, ...value }
}

export function saveSettings(settings: CompanionSettings): CompanionSettings {
  const next = { ...defaultSettings, ...settings, schemaVersion: 1 as const }
  Storage.set(SETTINGS_KEY, next, SHARED)
  return next
}

export type RuntimeMode = "demo" | "connected"

export function loadRuntimeMode(): RuntimeMode {
  return Storage.get<RuntimeMode>(RUNTIME_MODE_KEY, SHARED) === "connected" ? "connected" : "demo"
}

export function setRuntimeMode(mode: RuntimeMode): void {
  Storage.set(RUNTIME_MODE_KEY, mode, SHARED)
}

export function loadConnectedSnapshot(): VehicleSnapshot | null {
  // Must use the cross-script shared domain: the connected snapshot is written
  // from the app UI (index.tsx / connection-page) but also read by the widget
  // and by dashboard runs. Per-script (non-shared) storage would hide it.
  const value = Storage.get<VehicleSnapshot>(NETWORK_SNAPSHOT_KEY, SHARED)
  return isValidSnapshot(value) && value.source === "network" ? value : null
}

export function saveConnectedSnapshot(snapshot: VehicleSnapshot): VehicleSnapshot {
  if (!isValidSnapshot(snapshot) || snapshot.source !== "network") {
    throw new Error("CONNECTED_SNAPSHOT_INVALID")
  }
  Storage.set(NETWORK_SNAPSHOT_KEY, snapshot, SHARED)
  const widgetProjection: VehicleSnapshot = {
    ...snapshot,
    identity: { ...snapshot.identity, plateMasked: snapshot.identity.plateMasked },
  }
  Storage.set(WIDGET_SNAPSHOT_KEY, widgetProjection, SHARED)
  return snapshot
}

export function loadWidgetSnapshot(): VehicleSnapshot {
  if (loadRuntimeMode() === "connected") {
    const projected = Storage.get<VehicleSnapshot>(WIDGET_SNAPSHOT_KEY, SHARED)
    if (isValidSnapshot(projected) && projected.source === "network") return projected
  }
  const demo = Storage.get<VehicleSnapshot>(SNAPSHOT_KEY, SHARED)
  return isValidSnapshot(demo) ? demo : makeDemoSnapshot()
}

export function loadSnapshot(): VehicleSnapshot {
  if (loadRuntimeMode() === "connected") {
    const connected = loadConnectedSnapshot()
    if (connected) return connected
  }
  const value = Storage.get<VehicleSnapshot>(SNAPSHOT_KEY, SHARED)
  if (!isValidSnapshot(value)) {
    const seeded = makeDemoSnapshot()
    Storage.set(SNAPSHOT_KEY, seeded, SHARED)
    return seeded
  }
  return value
}

export function refreshDemoSnapshot(): VehicleSnapshot {
  const current = loadSnapshot()
  const now = new Date()
  const next: VehicleSnapshot = {
    ...current,
    fetchedAt: now.toISOString(),
    cachedAt: now.toISOString(),
    source: "fixture",
  }
  Storage.set(SNAPSHOT_KEY, next, SHARED)
  return next
}

export function resetDemoSnapshot(): VehicleSnapshot {
  const next = makeDemoSnapshot()
  Storage.set(SNAPSHOT_KEY, next, SHARED)
  return next
}

export function recordWidgetReload(): void {
  Storage.set(WIDGET_RELOAD_KEY, new Date().toISOString(), SHARED)
}

export function parseWidgetParameter(raw?: string): WidgetParameter {
  if (!raw?.trim()) return {}
  try {
    const value = JSON.parse(raw) as WidgetParameter
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

export function resolvePrivacy(parameter: WidgetParameter, settings = loadSettings()): boolean {
  if (parameter.privacy === "on") return true
  if (parameter.privacy === "off") return false
  return settings.privacyMode
}

export function getFreshness(snapshot: VehicleSnapshot | null, now = Date.now()): Freshness {
  if (!snapshot) return "missing"
  if (!isValidSnapshot(snapshot)) return "invalid"
  const settings = loadSettings()
  const cachedAt = new Date(snapshot.cachedAt).getTime()
  if (!Number.isFinite(cachedAt)) return "invalid"
  const ageMinutes = Math.max(0, (now - cachedAt) / 60000)
  if (ageMinutes <= settings.freshnessMinutes) return "fresh"
  if (ageMinutes <= settings.staleHours * 60) return "stale"
  return "expired"
}

function isValidSnapshot(value: VehicleSnapshot | null): value is VehicleSnapshot {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    value.localVehicleId &&
    value.identity?.displayName &&
    Array.isArray(value.checks) &&
    typeof value.cachedAt === "string" &&
    Number.isFinite(Date.parse(value.cachedAt)) &&
    typeof value.fetchedAt === "string" &&
    Number.isFinite(Date.parse(value.fetchedAt)) &&
    (value.energy.levelPercent == null ||
      (Number.isFinite(value.energy.levelPercent) && value.energy.levelPercent >= 0 && value.energy.levelPercent <= 100)),
  )
}
