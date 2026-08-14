export type EnergyType = "fuel" | "electric" | "hybrid" | "unknown"
export type KnownState = "closed" | "open" | "unknown"
export type LockState = "locked" | "unlocked" | "unknown"
export type ChargingState = "charging" | "complete" | "stopped" | "disconnected" | "unknown"
export type Freshness = "fresh" | "stale" | "expired" | "missing" | "invalid"

export interface TireState {
  pressureBar?: number
  targetBar?: number
  status: "normal" | "warning" | "unknown"
}

export interface VehicleCheck {
  id: string
  severity: "info" | "warning" | "critical"
  title: string
  detail?: string
}

export interface VehicleSnapshot {
  schemaVersion: 1
  localVehicleId: string
  // Raw VIN. Kept only to address the official vehicle-image endpoint; the
  // widget fetches that image itself, so the VIN must survive in the snapshot.
  vin?: string
  identity: {
    displayName: string
    brand?: string
    model?: string
    plateMasked?: string
    plate?: string
  }
  energy: {
    type: EnergyType
    levelPercent?: number
    remainingLiters?: number
    rangeKm?: number
    // Number for fuel/electric-only; string (e.g. "6.5 L/100km · 14.2 kWh/100km") for hybrids.
    consumption?: number | string
    consumptionUnit?: string
  }
  mileageKm?: number
  access: {
    lock: LockState
    doors: KnownState
    windows: KnownState
    roof: KnownState
    hood: KnownState
    trunk: KnownState
  }
  tires?: {
    frontLeft?: TireState
    frontRight?: TireState
    rearLeft?: TireState
    rearRight?: TireState
  }
  charging?: {
    state: ChargingState
    estimatedCompletionAt?: string
  }
  location?: {
    latitude: number
    longitude: number
    address?: string
    observedAt?: string
  }
  checks: VehicleCheck[]
  vehicleObservedAt?: string
  fetchedAt: string
  cachedAt: string
  source: "network" | "legacy" | "fixture"
}

export interface CompanionSettings {
  schemaVersion: 1
  privacyMode: boolean
  freshnessMinutes: number
  staleHours: number
  defaultVehicleId: string
  selectedVin?: string
  // 无胎压数据时的占位文案（部分车型不返回胎压，组件空出两行时显示）
  noTiresLine1?: string
  noTiresLine2?: string
}

export interface WidgetParameter {
  vehicleId?: string
  theme?: "overview" | "energy" | "safety"
  privacy?: "inherit" | "on" | "off"
}
