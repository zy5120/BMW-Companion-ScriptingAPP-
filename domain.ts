export type EnergyType = "fuel" | "electric" | "hybrid" | "unknown"
export type KnownState = "closed" | "open" | "unknown"
export type LockState = "locked" | "unlocked" | "unknown"
export type ChargingState = "charging" | "complete" | "stopped" | "disconnected" | "unknown"
export type Freshness = "fresh" | "stale" | "expired" | "missing" | "invalid"
// 登录 nonce 服务提供方：m.qqtlr.com / 自定义地址（自建服务或测试）
// 详见 nonce-provider.ts 与设置页「登录验证服务」。
export type NonceProviderId = "qqtlr" | "custom"

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
    // 主量（组件用）：油车=油量%，电车=电量%，混动=电量%
    levelPercent?: number
    // 油量 %（油车/混动）
    fuelPercent?: number
    // 电量 %（电车/混动）
    batteryPercent?: number
    remainingLiters?: number
    rangeKm?: number
    // Number for fuel/electric-only; string (e.g. "6.5 L/100km · 14.2 kWh/100km") for hybrids.
    consumption?: number | string
    consumptionUnit?: string
    // 48V 轻混平台（显示为燃油车，但标注轻混）
    mildHybrid?: boolean
  }
  mileageKm?: number
  access: {
    lock: LockState
    doors: KnownState
    windows: KnownState
    roof: KnownState
    hood: KnownState
    trunk: KnownState
    // 细化：各车门/车窗独立状态（接口返回时才有，否则 undefined）
    doorStates?: {
      leftFront: KnownState
      leftRear: KnownState
      rightFront: KnownState
      rightRear: KnownState
    }
    windowStates?: {
      leftFront: KnownState
      leftRear: KnownState
      rightFront: KnownState
      rightRear: KnownState
    }
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
    // 充电目标电量（%），纯电/混动接口返回（如 80）
    targetPercent?: number
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
  // 登录 nonce 服务提供方（可插拔，见 nonce-provider.ts）
  nonceProvider?: NonceProviderId
  customNonceUrl?: string
  // 记住手机号，避免重复输入（仅本机保存）
  savedPhone?: string
  // 已查看过的更新版本号（用于「更新展示」sheet，见 changelog.ts）
  lastSeenVersion?: string
  // 浅色模式下也强制组件使用深色背景
  alwaysDarkBackground?: boolean
  // 手动能源类型覆盖（按 VIN 兑底，key 为 VIN；自动识别失败/有误时用户可手动指定）
  energyTypeOverrides?: Record<string, "fuel" | "electric" | "hybrid">
}

export interface WidgetParameter {
  vehicleId?: string
  theme?: "overview" | "energy" | "safety"
  privacy?: "inherit" | "on" | "off"
}
