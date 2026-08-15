import { Script } from "scripting"
import type { CompanionSettings, Freshness, VehicleSnapshot, WidgetParameter } from "./domain"
import { makeDemoSnapshot } from "./fixtures"

// 当前脚本名（App 与桌面组件返回一致）→ 生成共享 key 的唯一前缀。
// 用户可能在同一设备添加多个脚本（每辆一台车），每个脚本必须使用自己的
// 共享 key，否则第二个脚本会覆盖第一个脚本的组件数据。
export function scriptKeyNamespace(): string {
  const name = typeof Script !== "undefined" && Script.name ? Script.name : "bmw-companion"
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return safe || "bmw-companion"
}

const NS = scriptKeyNamespace()
const SNAPSHOT_KEY = `bmw.companion.v2.${NS}.snapshot.demo-bmw-i4`
const NETWORK_SNAPSHOT_KEY = `bmw.companion.v2.${NS}.snapshot.connected`
const WIDGET_SNAPSHOT_KEY = `bmw.companion.v2.${NS}.snapshot.widget-projection`
const RUNTIME_MODE_KEY = `bmw.companion.v2.${NS}.runtimeMode`
const SETTINGS_KEY = `bmw.companion.v2.${NS}.settings`
const WIDGET_RELOAD_KEY = `bmw.companion.v2.${NS}.widget.lastReloadAt`

// 桌面组件是独立扩展进程，读不到主 App 的插件私有存储；
// 以下 key 是组件正常工作必需的，保留在跨环境共享域（不含敏感信息）。
const SHARED = { shared: true }

export const defaultSettings: CompanionSettings = {
  schemaVersion: 1,
  privacyMode: false,
  freshnessMinutes: 15,
  staleHours: 6,
  defaultVehicleId: "demo-bmw-i4",
  selectedVin: "",
  noTiresLine1: "",
  noTiresLine2: "",
  nonceProvider: "qqtlr",
  customNonceUrl: "",
  savedPhone: "",
  lastSeenVersion: "",
  alwaysDarkBackground: false,
  energyTypeOverrides: {},
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
  // 插件私有存储（per-script）：数据只属于本插件。注意：桌面组件可能读不到
  // 主 App 写入的私有数据（组件扩展与主 App 存储隔离），若组件失效需改回共享池。
  const value = Storage.get<VehicleSnapshot>(NETWORK_SNAPSHOT_KEY)
  return isValidSnapshot(value) && value.source === "network" ? value : null
}

export function saveConnectedSnapshot(snapshot: VehicleSnapshot): VehicleSnapshot {
  if (!isValidSnapshot(snapshot) || snapshot.source !== "network") {
    throw new Error("CONNECTED_SNAPSHOT_INVALID")
  }
  Storage.set(NETWORK_SNAPSHOT_KEY, snapshot)
  const widgetProjection: VehicleSnapshot = {
    ...snapshot,
    identity: { ...snapshot.identity, plateMasked: snapshot.identity.plateMasked },
  }
  Storage.set(WIDGET_SNAPSHOT_KEY, widgetProjection, SHARED)
  return snapshot
}

// 兑底：应用用户手动指定的能源类型覆盖（按 VIN）。自动识别失败/有误时使用。
export function applyEnergyOverride(snapshot: VehicleSnapshot): VehicleSnapshot {
  const key = snapshot.vin ?? snapshot.localVehicleId
  const override = loadSettings().energyTypeOverrides?.[key]
  if (override &&
      (override === "fuel" || override === "electric" || override === "hybrid") &&
      override !== snapshot.energy.type) {
    return { ...snapshot, energy: { ...snapshot.energy, type: override } }
  }
  return snapshot
}

export function loadWidgetSnapshot(): VehicleSnapshot {
  if (loadRuntimeMode() === "connected") {
    const projected = Storage.get<VehicleSnapshot>(WIDGET_SNAPSHOT_KEY, SHARED)
    if (isValidSnapshot(projected) && projected.source === "network") return applyEnergyOverride(projected)
  }
  const demo = Storage.get<VehicleSnapshot>(SNAPSHOT_KEY)
  return applyEnergyOverride(isValidSnapshot(demo) ? demo : makeDemoSnapshot())
}

export function loadSnapshot(): VehicleSnapshot {
  if (loadRuntimeMode() === "connected") {
    const connected = loadConnectedSnapshot()
    if (connected) return applyEnergyOverride(connected)
  }
  const value = Storage.get<VehicleSnapshot>(SNAPSHOT_KEY)
  if (!isValidSnapshot(value)) {
    const seeded = makeDemoSnapshot()
    Storage.set(SNAPSHOT_KEY, seeded)
    return applyEnergyOverride(seeded)
  }
  return applyEnergyOverride(value)
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
  Storage.set(SNAPSHOT_KEY, next)
  return next
}

export function resetDemoSnapshot(): VehicleSnapshot {
  const next = makeDemoSnapshot()
  Storage.set(SNAPSHOT_KEY, next)
  return next
}

export function recordWidgetReload(): void {
  Storage.set(WIDGET_RELOAD_KEY, new Date().toISOString())
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
