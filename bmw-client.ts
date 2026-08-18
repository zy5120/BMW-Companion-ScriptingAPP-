import { fetch } from "scripting"
import JSEncrypt from "./vendor/jsencrypt"
import type { KnownState, LockState, TireState, VehicleCheck, VehicleSnapshot } from "./domain"
import { BMW_HEADERS, BMW_HOST, brandUserAgent, COMPAT_HEADERS_X } from "./compat-config"
import { requestCompatNonce } from "./nonce-provider"
import { makeSession, type BMWSessionSecrets } from "./session-vault"
import { applyEnergyOverride } from "./storage"

interface CaptchaChallenge {
  verifyId: string
  mobile: string
}

export interface SmsChallenge extends CaptchaChallenge {
  otpId: string
}

interface BMWLoginGrant {
  refreshToken: string
  gcid: string
}

interface RawTokenData {
  access_token?: unknown
  refresh_token?: unknown
  gcid?: unknown
  expires_in?: unknown
}

interface RawVehicle {
  vin?: unknown
  brand?: unknown
  model?: unknown
  licensePlate?: unknown
  properties?: Record<string, any>
  [key: string]: unknown
}

function dataFromString(value: string): Data {
  const data = Data.fromString(value)
  if (!data) throw new Error("DATA_ENCODING_FAILED")
  return data
}

function normalizedMobile(value: string): string {
  const digits = value.replace(/\D/g, "")
  const mobile = digits.startsWith("86") ? digits : digits.length === 11 ? `86${digits}` : digits
  if (!/^86\d{11}$/.test(mobile)) throw new Error("MOBILE_INVALID")
  return mobile
}

async function requestJSON<T>(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<T> {
  const response = await fetch(`${BMW_HOST}${path}`, {
    method: init.method ?? "GET",
    headers: { ...BMW_HEADERS, ...init.headers },
    body: init.body,
    timeout: 15,
    handleRedirect: async request => request.url.startsWith(BMW_HOST) ? request : null,
    debugLabel: `BMW ${path}`,
  })
  const text = await response.text()
  if (text.length > 2_000_000) throw new Error("BMW_RESPONSE_TOO_LARGE")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`BMW_NON_JSON_${response.status}`)
  }
  if (!response.ok) throw new Error(`BMW_HTTP_${response.status}`)
  return value as T
}

function requireSuccessData<T>(value: unknown, operation: string): T {
  const result = value as { code?: unknown; data?: unknown; description?: unknown }
  if (result?.code !== 200 || result.data == null) {
    throw new Error(`${operation}_REJECTED`)
  }
  return result.data as T
}

function findCaptchaPosition(base64: string): string {
  if (base64.length > 2_000_000) throw new Error("CAPTCHA_IMAGE_TOO_LARGE")
  const image = UIImage.fromBase64String(base64)
  const pixelData = image?.getPixelData()
  const bytes = pixelData?.data.toUint8Array()
  if (!pixelData || !bytes) throw new Error("CAPTCHA_IMAGE_INVALID")

  const { width, height } = pixelData
  if (width < 50 || height < 75 || width > 2_000 || height > 2_000 || bytes.length !== width * height * 4) {
    throw new Error("CAPTCHA_IMAGE_DIMENSIONS_INVALID")
  }
  const blockWidth = 15
  const blockHeight = 75
  const target = [220, 230, 221]
  const tolerance = 15

  const matchesTarget = (x: number, y: number): boolean => {
    const offset = (y * width + x) * 4
    return Math.abs(bytes[offset] - target[0]) <= tolerance &&
      Math.abs(bytes[offset + 1] - target[1]) <= tolerance &&
      Math.abs(bytes[offset + 2] - target[2]) <= tolerance
  }

  // Fixed bounds only. Use five cheap probes before the full 15×75 check so
  // arbitrary images cannot force the expensive inner scan at every pixel.
  for (let y = 0; y < height - blockHeight; y += 1) {
    for (let x = 0; x < width - blockWidth; x += 1) {
      if (!matchesTarget(x, y) ||
          !matchesTarget(x + blockWidth - 1, y) ||
          !matchesTarget(x, y + blockHeight - 1) ||
          !matchesTarget(x + blockWidth - 1, y + blockHeight - 1) ||
          !matchesTarget(x + Math.floor(blockWidth / 2), y + Math.floor(blockHeight / 2))) {
        continue
      }
      let found = true
      for (let dy = 0; dy < blockHeight && found; dy += 1) {
        for (let dx = 0; dx < blockWidth; dx += 1) {
          if (!matchesTarget(x + dx, y + dy)) {
            found = false
            break
          }
        }
      }
      if (found) return ((x - 26) / width).toFixed(2)
    }
  }
  throw new Error("CAPTCHA_POSITION_NOT_FOUND")
}

async function createAndVerifyCaptcha(mobile: string): Promise<CaptchaChallenge> {
  // 滑动验证随机 x 兜底：先试固定值，失败则随机换 correlation/x 重试
  const candidates: Array<Record<string, string>> = [COMPAT_HEADERS_X]
  for (let i = 0; i < 15; i++) candidates.push(randomHeadersX())

  let data: { verifyId: string; backGroundImg: string } | undefined
  let headersX = COMPAT_HEADERS_X
  let lastError: unknown

  for (const candidate of candidates) {
    try {
      const created = await requestJSON<unknown>("/eadrax-coas/v2/cop/create-captcha", {
        method: "POST",
        headers: candidate,
        body: JSON.stringify({ mobile, brand: "BMW" }),
      })
      const result = requireSuccessData<{ verifyId?: unknown; backGroundImg?: unknown }>(created, "CAPTCHA_CREATE")
      if (typeof result.verifyId !== "string" || typeof result.backGroundImg !== "string") {
        throw new Error("CAPTCHA_CONTRACT_INVALID")
      }
      data = { verifyId: result.verifyId, backGroundImg: result.backGroundImg }
      headersX = candidate
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!data) throw lastError ?? new Error("CAPTCHA_CREATE_REJECTED")

  currentHeadersX = headersX
  persistHeadersX()

  const position = findCaptchaPosition(data.backGroundImg)
  const verified = await requestJSON<unknown>("/eadrax-coas/v2/cop/verify-captcha", {
    method: "POST",
    headers: headersX,
    body: JSON.stringify({ position, verifyId: data.verifyId, mobile }),
  })
  const result = verified as { code?: unknown }
  if (result.code !== 200) throw new Error("CAPTCHA_VERIFY_REJECTED")
  return { verifyId: data.verifyId, mobile }
}

// 滑动验证随机 x：x = 前缀 + md5(uuid) + md5(uuid)，截取 64 位
const HEADERS_X_KEY = "bmw.companion.v2.headersX"

function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5Hex(value: string): string {
  return Crypto.md5(dataFromString(value)).toHexString()
}

function randomHeadersX(): Record<string, string> {
  const prefixes = ["x", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]
  const uuid = uuidv4()
  const x = (prefixes[Math.floor(Math.random() * prefixes.length)] + md5Hex(uuidv4()) + md5Hex(uuidv4())).substr(0, 64)
  return { "x-correlation-id": uuid, "bmw-correlation-id": uuid, x }
}

function loadPersistedHeadersX(): Record<string, string> {
  try {
    const saved = Storage.get<Record<string, string>>(HEADERS_X_KEY)
    if (saved && typeof saved.x === "string" && saved.x.length === 64) return saved
  } catch {}
  return COMPAT_HEADERS_X
}

// 当前可用的风控头（含随机兜底结果），登录/刷新共用
let currentHeadersX: Record<string, string> = loadPersistedHeadersX()

function persistHeadersX(): void {
  try {
    Storage.set(HEADERS_X_KEY, currentHeadersX)
  } catch {}
}

function parseLoginGrant(value: unknown): BMWLoginGrant {
  const data = requireSuccessData<RawTokenData>(value, "LOGIN")
  if (typeof data.refresh_token !== "string" || typeof data.gcid !== "string") {
    throw new Error("LOGIN_TOKEN_CONTRACT_INVALID")
  }
  return { refreshToken: data.refresh_token, gcid: data.gcid }
}

async function renewGrant(grant: BMWLoginGrant): Promise<BMWSessionSecrets> {
  const nonce = await requestCompatNonce(grant.gcid, "refresh")
  const value = await requestJSON<RawTokenData>("/eadrax-coas/v2/oauth/token", {
    method: "POST",
    headers: {
      ...currentHeadersX,
      "x-login-nonce": nonce,
    },
    body: `grant_type=refresh_token&refresh_token=${grant.refreshToken}`,
  })
  if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string") {
    throw new Error("REFRESH_TOKEN_CONTRACT_INVALID")
  }
  return makeSession({
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    gcid: typeof value.gcid === "string" ? value.gcid : grant.gcid,
    expiresInSeconds: typeof value.expires_in === "number" ? value.expires_in : 3000,
  })
}

export async function loginWithPassword(phone: string, password: string): Promise<BMWSessionSecrets> {
  const mobile = normalizedMobile(phone)
  if (!password || password.length > 256) throw new Error("PASSWORD_INVALID")
  const [captcha, publicKeyResponse] = await Promise.all([
    createAndVerifyCaptcha(mobile),
    requestJSON<unknown>("/eadrax-coas/v1/cop/publickey", { method: "GET" }),
  ])
  // Only disclose the mobile to the compatibility provider after BMW captcha
  // verification succeeds.
  const nonce = await requestCompatNonce(mobile, "login")
  const { verifyId } = captcha
  const publicKey = requireSuccessData<{ value?: unknown }>(publicKeyResponse, "PUBLIC_KEY").value
  if (typeof publicKey !== "string" || publicKey.length > 16_384) throw new Error("PUBLIC_KEY_INVALID")
  const encryptor = new JSEncrypt()
  encryptor.setPublicKey(publicKey)
  const encryptedPassword = encryptor.encrypt(password)
  if (!encryptedPassword) throw new Error("PASSWORD_ENCRYPTION_FAILED")

  const login = await requestJSON<unknown>("/eadrax-coas/v2/login/pwd", {
    method: "POST",
    headers: { ...currentHeadersX, "x-login-nonce": nonce },
    body: JSON.stringify({
      mobile,
      password: encryptedPassword,
      verifyId,
      deviceId: Crypto.md5(dataFromString(mobile)).toHexString(),
    }),
  })
  return renewGrant(parseLoginGrant(login))
}

export async function requestSmsCode(phone: string): Promise<SmsChallenge> {
  const mobile = normalizedMobile(phone)
  const captcha = await createAndVerifyCaptcha(mobile)
  const response = await requestJSON<unknown>("/eadrax-coas/v1/cop/message", {
    method: "POST",
    body: JSON.stringify({
      mobile,
      deviceId: Crypto.md5(dataFromString(mobile.slice(0, 16))).toHexString(),
      verifyId: captcha.verifyId,
    }),
  })
  const data = requireSuccessData<{ otpID?: unknown }>(response, "SMS_REQUEST")
  if (typeof data.otpID !== "string") throw new Error("SMS_CHALLENGE_INVALID")
  return { ...captcha, otpId: data.otpID }
}

export async function loginWithSms(challenge: SmsChallenge, code: string): Promise<BMWSessionSecrets> {
  const otpMsg = code.replace(/\D/g, "")
  if (!/^\d{4,8}$/.test(otpMsg)) throw new Error("SMS_CODE_INVALID")
  const nonce = await requestCompatNonce(challenge.mobile, "login")
  const login = await requestJSON<unknown>("/eadrax-coas/v2/login/sms", {
    method: "POST",
    headers: { ...currentHeadersX, "x-login-nonce": nonce },
    body: JSON.stringify({ mobile: challenge.mobile, otpId: challenge.otpId, otpMsg }),
  })
  return renewGrant(parseLoginGrant(login))
}

export async function renewSession(session: BMWSessionSecrets): Promise<BMWSessionSecrets> {
  return renewGrant({ refreshToken: session.refreshToken, gcid: session.gcid })
}

function knownState(value: unknown): KnownState {
  return value === "CLOSED" ? "closed" : value === "OPEN" ? "open" : "unknown"
}

function lockState(value: unknown): LockState {
  return value === "LOCKED" || value === "SECURED" ? "locked" :
    value === "UNLOCKED" ? "unlocked" : "unknown"
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

// 比官方更敏感的偏低阈值：胎压低于该值（bar）时，即使 BMW 官方未报警也视为偏低
const TIRE_LOW_PRESSURE_BAR = 2.2

function tire(
  value: any,
  options?: { officialLow?: boolean },
): TireState | undefined {
  const current = finiteNumber(value?.status?.currentPressure)
  const target = finiteNumber(value?.status?.targetPressure)
  if (current == null && target == null) return undefined
  const pressureBar = current == null ? undefined : current / 100
  const targetBar = target == null ? undefined : target / 100
  let warning = false
  if (pressureBar != null && pressureBar < TIRE_LOW_PRESSURE_BAR) {
    // 官方可能还未报警，但我们认为偏低
    warning = true
  } else if (current != null && target != null) {
    warning = current < target - 10
  } else if (options?.officialLow) {
    // 官方 checkControlMessages 已报胎压过低 → 跟随官方
    warning = true
  }
  return { pressureBar, targetBar, status: warning ? "warning" : "normal" }
}

const CHECK_TYPE_LABELS: Record<string, string> = {
  TIRE_PRESSURE: "胎压",
  ENGINE_OIL: "机油",
  FUEL: "燃油",
  FUEL_LEVEL: "燃油",
  RANGE: "续航里程",
  OIL_SERVICE: "保养",
  SERVICE: "保养",
  BRAKE_FLUID: "制动液",
  COOLANT: "冷却液",
  COOLANT_LEVEL: "冷却液",
  WASHER_FLUID: "玻璃水",
  WASHER_WATER: "玻璃水",
  BATTERY: "蓄电池",
  VEHICLE_STATUS: "车辆",
  VEHICLE: "车辆",
  DOOR: "车门",
  WINDOW: "车窗",
  ROOF: "天窗",
  TRUNK: "后备箱",
  HOOD: "引擎盖",
  EMISSION: "排放系统",
  EXHAUST: "排气系统",
  LIGHT: "灯光",
  AIR_FILTER: "空气滤芯",
  SPARK_PLUG: "火花塞",
  TIRE: "轮胎",
  AWD: "四驱系统",
  STEERING: "转向系统",
  SUSPENSION: "悬挂系统",
  AIRBAG: "安全气囊",
  SEAT_BELT: "安全带",
  ADBLUE: "尿素",
  DPF: "颗粒捕捉器",
  PARTICLE_FILTER: "颗粒捕捉器",
  DIESEL_PARTICLE_FILTER: "颗粒捕捉器",
}

function rawText(item: any): string {
  const candidates = [
    item?.name,
    item?.title,
    item?.text,
    item?.localizedText,
    item?.description,
    item?.message,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return ""
}

function checkSeverity(item: any): VehicleCheck["severity"] {
  const severity = String(item?.severity ?? "").trim().toUpperCase()
  if (["HIGH", "HIGHEST", "CRITICAL"].includes(severity)) return "critical"
  return "warning"
}

function checkTitle(item: any): string {
  const text = rawText(item)
  if (text) return text.slice(0, 80)
  const type = String(item?.type ?? "").trim().toUpperCase()
  const typeLabel = CHECK_TYPE_LABELS[type] ?? (type || "车辆")
  const severity = String(item?.severity ?? "").trim().toUpperCase()
  if (["LOW", "LOWEST"].includes(severity)) return `${typeLabel}过低`
  if (["HIGH", "HIGHEST"].includes(severity)) return `${typeLabel}过高`
  if (["MEDIUM", "MIDDLE"].includes(severity)) return `${typeLabel}异常`
  return typeLabel
}

function checkDetail(item: any): string | undefined {
  const text = rawText(item)
  if (text) return text.slice(0, 240)
  const type = String(item?.type ?? "").trim().toUpperCase()
  const typeLabel = CHECK_TYPE_LABELS[type] ?? type
  const severity = String(item?.severity ?? "").trim().toUpperCase()
  const severityLabel =
    ["LOW", "LOWEST"].includes(severity) ? "过低" :
    ["HIGH", "HIGHEST"].includes(severity) ? "过高" :
    ["MEDIUM", "MIDDLE"].includes(severity) ? "异常" : ""
  return typeLabel && severityLabel ? `${typeLabel}${severityLabel}` : undefined
}

// 识别逻辑①：vehicle-data/profile 接口的 driveTrain 直接字段（COMBUSTION / ELECTRIC / HYBRID）。
// 这是最可靠的驱动类型来源，替代基于车况能源字段的推断。
function driveTypeFromProfile(profile?: Record<string, any> | null): "fuel" | "electric" | "hybrid" | "unknown" {
  const dt = typeof profile?.driveTrain === "string" ? profile.driveTrain.trim().toUpperCase() : ""
  if (!dt) return "unknown"
  if (/HYBRID|PHEV/.test(dt)) return "hybrid"
  if (/ELECTRIC|BEV/.test(dt)) return "electric"
  if (/COMBUSTION|^CO$|FUEL|ICE|DIESEL|GASOLINE|PETROL/.test(dt)) return "fuel"
  return "unknown"
}

// 拉取车辆数据档案（vehicle-data/profile），取 driveTrain 直接字段
async function fetchVehicleProfile(
  session: BMWSessionSecrets,
  vin: string,
  brand: "BMW" | "MINI",
): Promise<Record<string, any> | null> {
  try {
    return await requestJSON<Record<string, any>>("/eadrax-vcs/v5/vehicle-data/profile", {
      method: "GET",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "bmw-vin": vin,
        "x-user-agent": brandUserAgent(brand),
      },
    })
  } catch {
    return null
  }
}

function normalizeVehicle(
  vehicle: RawVehicle,
  state: Record<string, any>,
  profileType: "fuel" | "electric" | "hybrid" | "unknown",
): VehicleSnapshot {
  const vin = typeof vehicle.vin === "string" ? vehicle.vin : ""
  if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) throw new Error("VEHICLE_VIN_INVALID")
  const electric = state.electricChargingState
  const fuel = state.combustionFuelLevel
  const level = finiteNumber(electric?.chargingLevelPercent ?? fuel?.remainingFuelPercent)
  const range = finiteNumber(electric?.range ?? fuel?.range)
  // 能源类型只认两个逻辑：1) profile 的 driveTrain 直接字段；2) 用户手动覆盖（applyEnergyOverride，见 storage）。
  // 不再基于车况能源字段推断，避免纯电车因接口返回空油量对象被误判成混动。
  const energyType = profileType
  const doors = state.doorsState ?? {}
  const windows = state.windowsState ?? {}
  const roof = state.roofState ?? {}
  // 「需要关注」只使用实时、权威的告警：仅保留 HIGH/HIGHEST/CRITICAL 级别的 checkControlMessages。
  // LOW/MEDIUM 多为信息性/历史记录（例如胎压 LOW 但车机未告警），不显示，避免误报。
  const rawChecks = Array.isArray(state.checkControlMessages) ? state.checkControlMessages : []
  const checks: VehicleCheck[] = rawChecks
    .filter(item => ["HIGH", "HIGHEST", "CRITICAL"].includes(String(item?.severity ?? "").trim().toUpperCase()))
    .slice(0, 20)
    .map((item: any, index: number) => ({
      id: String(item?.id ?? item?.type ?? `bmw-check-${index}`),
      severity: checkSeverity(item),
      title: checkTitle(item),
      detail: checkDetail(item),
    }))
  // BMW 接口通常不把「油量低」作为 checkControlMessage 返回，本地按油量阈值补一条，
  // 让「需要关注」如实反映油量过低（油车/混动且油量 < 10%）。
  if (!electric && level != null && level < 10 &&
      !checks.some(check => /FUEL|RANGE|油量|燃油|续航/.test(`${check.id}${check.title}`))) {
    checks.push({
      id: "FUEL_LEVEL_LOW",
      severity: "warning",
      title: "油量过低",
      detail: `当前油量 ${Math.round(level)}%，建议尽快加油`,
    })
  }
  // 胎压状态只跟随高级别胎压告警（LOW 级是信息提示，车机不告警，避免误标）
  const pressureLow = rawChecks.some(item => {
    const severity = String(item?.severity ?? "").trim().toUpperCase()
    return ["HIGH", "HIGHEST", "CRITICAL"].includes(severity) &&
      String(item?.type ?? item?.id ?? "").toUpperCase().includes("TIRE_PRESSURE")
  })
  const tireRaw = state.tireState as Record<string, any> | undefined
  const tires = tireRaw ? {
    frontLeft: tire(tireRaw.frontLeft, { officialLow: pressureLow }),
    frontRight: tire(tireRaw.frontRight, { officialLow: pressureLow }),
    rearLeft: tire(tireRaw.rearLeft, { officialLow: pressureLow }),
    rearRight: tire(tireRaw.rearRight, { officialLow: pressureLow }),
  } : undefined
  const now = new Date().toISOString()
  const coordinates = state.location?.coordinates
  const latitude = finiteNumber(coordinates?.latitude)
  const longitude = finiteNumber(coordinates?.longitude)
  // BMW 后台返回的坐标已是纠正过的，直接使用，不做坐标系转换
  const location = latitude != null && longitude != null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? {
        latitude,
        longitude,
        address: typeof state.location?.address?.formatted === "string"
          ? state.location.address.formatted.slice(0, 160) : undefined,
        observedAt: typeof state.location?.lastUpdatedAt === "string" ? state.location.lastUpdatedAt : undefined,
      }
    : undefined

  // 充电状态细化：按连接状态 + 接口 chargingStatus 判断（未连接/充电中/已充满）
function chargingState(electric: Record<string, any>): "charging" | "complete" | "disconnected" | "unknown" {
  const status = String(electric.chargingStatus ?? "").toUpperCase()
  if (status === "FINISHED" || status === "CHARGING_FULLY_CHARGED" || status === "FULLY_CHARGED") return "complete"
  if (electric.isChargerConnected === true || status === "CHARGING") return "charging"
  return "disconnected"
}

  return {
    schemaVersion: 1,
    localVehicleId: `bmw-${Crypto.sha256(dataFromString(vin)).toHexString().slice(0, 12)}`,
    vin,
    identity: {
      displayName: [vehicle.brand, vehicle.model].filter(value => typeof value === "string").join(" ") || "BMW",
      brand: typeof vehicle.brand === "string" ? vehicle.brand : "BMW",
      model: typeof vehicle.model === "string" ? vehicle.model : undefined,
      plateMasked: typeof vehicle.licensePlate === "string" && vehicle.licensePlate.length > 2
        ? `${vehicle.licensePlate.slice(0, 1)}***${vehicle.licensePlate.slice(-1)}` : undefined,
      plate: typeof vehicle.licensePlate === "string" ? vehicle.licensePlate : undefined,
    },
    energy: {
      type: energyType,
      levelPercent: level != null && level >= 0 && level <= 100 ? level : undefined,
      remainingLiters: finiteNumber(fuel?.remainingFuelLiters),
      rangeKm: range != null && range >= 0 ? range : undefined,
    },
    mileageKm: finiteNumber(state.currentMileage),
    access: {
      lock: lockState(doors.combinedSecurityState),
      doors: knownState(doors.combinedState),
      windows: knownState(windows.combinedState),
      roof: knownState(roof.roofState),
      hood: knownState(doors.hood),
      trunk: knownState(doors.trunk),
      doorStates: {
        leftFront: knownState(doors.leftFront),
        leftRear: knownState(doors.leftRear),
        rightFront: knownState(doors.rightFront),
        rightRear: knownState(doors.rightRear),
      },
      windowStates: {
        leftFront: knownState(windows.leftFront),
        leftRear: knownState(windows.leftRear),
        rightFront: knownState(windows.rightFront),
        rightRear: knownState(windows.rightRear),
      },
    },
    tires,
    charging: electric ? {
      state: chargingState(electric),
      estimatedCompletionAt: typeof electric.chargingEndTime === "string" ? electric.chargingEndTime : undefined,
      targetPercent: finiteNumber(electric.chargingTarget),
    } : undefined,
    location,
    checks,
    vehicleObservedAt: typeof state.lastUpdatedAt === "string" ? state.lastUpdatedAt : undefined,
    fetchedAt: now,
    cachedAt: now,
    source: "network",
  }
}

export interface MaintenanceItem {
  type: string
  name: string
  dateTime?: string
  mileageKm?: number
  status: string
}

// 拉取保养计划（CBS）：eadrax-seamlead/api/v1/demands 的 cbs 数组
async function fetchMaintenance(
  session: BMWSessionSecrets,
  vin: string,
  brand: "BMW" | "MINI",
): Promise<MaintenanceItem[]> {
  try {
    const response = await requestJSON<{ cbs?: Array<Record<string, any>> }>(
      "/eadrax-seamlead/api/v1/demands",
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "bmw-vin": vin,
          "x-user-agent": brandUserAgent(brand),
        },
      },
    )
    const cbs = Array.isArray(response?.cbs) ? response.cbs : []
    return cbs.map(item => ({
      type: typeof item.type === "string" ? item.type : "",
      name: typeof item.name === "string" ? item.name : item.type,
      dateTime: typeof item.dateTime === "string" ? item.dateTime : undefined,
      mileageKm: finiteNumber(item.mileage),
      status: typeof item.status === "string" ? item.status : "",
    }))
  } catch {
    return []
  }
}

// 把「需要保养/已到期」的 CBS 保养项转成「需要关注」条目：
// 仅当状态非正常（status ≠ OK）或按日期/里程已过期时才提醒，不做“即将到期”猜测，避免误报。
function buildMaintenanceChecks(items: MaintenanceItem[]): VehicleCheck[] {
  const now = Date.now()
  const checks: VehicleCheck[] = []
  for (const item of items) {
    const status = (item.status || "").trim().toUpperCase()
    const notOk = status !== "" && status !== "OK" && status !== "NORMAL"
    const dueAt = item.dateTime ? Date.parse(item.dateTime) : NaN
    const overdueByDate = Number.isFinite(dueAt) && dueAt < now
    const overdueByMileage = item.mileageKm != null && item.mileageKm <= 0
    if (!notOk && !overdueByDate && !overdueByMileage) continue
    const overdue = overdueByDate || overdueByMileage
    const detailParts: string[] = []
    if (item.dateTime) detailParts.push(`最迟 ${item.dateTime.slice(0, 10)}`)
    if (item.mileageKm != null) detailParts.push(`剩余 ${item.mileageKm} km`)
    checks.push({
      id: `MAINTENANCE_${item.type || "ITEM"}`,
      severity: "warning",
      title: overdue ? `${item.name}已到期` : `${item.name}需要保养`,
      detail: detailParts.length ? detailParts.join(" · ") : undefined,
    })
  }
  return checks
}

interface ConsumptionInfo {
  value: number | string
  unit: string
}

// Mirrors the reference widget's sustainability() call:
// GET /eadrax-suscs/v1/vehicles/sustainability with bmw-vin + x-gcid headers.
async function fetchConsumption(
  session: BMWSessionSecrets,
  vin: string,
  fuelType: "fuel" | "electric" | "hybrid" | "unknown",
  brand: "BMW" | "MINI" = "BMW",
): Promise<ConsumptionInfo | undefined> {
  try {
    const response = await requestJSON<unknown>("/eadrax-suscs/v1/vehicles/sustainability", {
      method: "GET",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "bmw-vin": vin,
        "x-gcid": session.gcid,
        "x-user-agent": brandUserAgent(brand),
      },
    })
    const result = response as {
      status?: unknown
      widget?: {
        monthly?: Record<string, any>
        lastTrip?: {
          fuelConsumption?: { averageConsumption?: unknown }
          electricConsumption?: { averageConsumption?: unknown }
        }
      }
    }
    if (result?.status !== "Success" || !result.widget?.lastTrip) return undefined
    const monthly = result.widget.monthly ?? {}
    const lastTrip = result.widget.lastTrip
    const hasElectric = Object.prototype.hasOwnProperty.call(monthly, "totalElectricConsumption")
    const hasCombustion = Object.prototype.hasOwnProperty.call(monthly, "totalCombustionConsumption")
    const fuelValue = finiteNumber(lastTrip.fuelConsumption?.averageConsumption)
    const electricValue = finiteNumber(lastTrip.electricConsumption?.averageConsumption)
    const round = (value: number) => Math.round(value * 10) / 10

    // 油电混合：两个月度字段都存在 → 能耗（油耗 + 电耗一起展示）
    if (hasElectric && hasCombustion) {
      const parts: string[] = []
      if (fuelValue != null && fuelValue > 0) parts.push(`${fuelValue.toFixed(1)} L/100km`)
      if (electricValue != null && electricValue > 0) parts.push(`${electricValue.toFixed(1)} kWh/100km`)
      return parts.length ? { value: parts.join(" · "), unit: "" } : undefined
    }
    // 纯电 → 电耗
    if (hasElectric) {
      if (electricValue != null && electricValue > 0) return { value: round(electricValue), unit: "kWh/100km" }
      return undefined
    }
    // 纯油（或状态判断为油车）→ 油耗
    if (hasCombustion || fuelType === "fuel" || fuelType === "hybrid") {
      if (fuelValue != null && fuelValue > 0) return { value: round(fuelValue), unit: "L/100km" }
      return undefined
    }
    if (fuelType === "electric" && electricValue != null && electricValue > 0) {
      return { value: round(electricValue), unit: "kWh/100km" }
    }
    return undefined
  } catch (error) {
    console.warn("sustainability unavailable:", error instanceof Error ? error.message : String(error))
    return undefined
  }
}

export interface VehicleListItem {
  vin: string
  brand: "BMW" | "MINI"
  model: string
  licensePlate?: string
  // 是否已开通互联驾驶（未开通的车辆无法获取车况，选择时需提示）
  connected: boolean
}

// 同时拉取宝马和 MINI 的车辆条目（x-user-agent 品牌标识决定接口返回哪个品牌）
async function fetchVehicleEntries(
  session: BMWSessionSecrets,
  brand: "BMW" | "MINI",
): Promise<Array<{ vin: string; brand: "BMW" | "MINI"; vehicle: RawVehicle; connected: boolean }>> {
  const vehicles = await requestJSON<{
    mappingInfos?: Array<{
      vin?: unknown
      cnData?: RawVehicle
      isAssociated?: unknown
      vehicleMappingType?: unknown
    }>
  }>(
    "/eadrax-vcs/v5/vehicle-list?",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "x-user-agent": brandUserAgent(brand),
      },
      body: "{}",
    },
  )
  const entries: Array<{ vin: string; brand: "BMW" | "MINI"; vehicle: RawVehicle; connected: boolean }> = []
  for (const entry of vehicles.mappingInfos ?? []) {
    const cn = entry.cnData ?? (entry as RawVehicle | undefined)
    const vin = typeof entry?.vin === "string" ? entry.vin : typeof cn?.vin === "string" ? cn.vin : ""
    if (!vin) continue
    const connected = entry.isAssociated === true && entry.vehicleMappingType === "CONNECTED"
    entries.push({
      vin,
      brand,
      vehicle: cn ? { ...cn, vin } : ({ ...(entry as RawVehicle), vin } as RawVehicle),
      connected,
    })
  }
  return entries
}

export async function fetchVehicleList(session: BMWSessionSecrets): Promise<VehicleListItem[]> {
  const items: VehicleListItem[] = []
  const seen = new Set<string>()
  for (const brand of ["BMW", "MINI"] as const) {
    const entries = await fetchVehicleEntries(session, brand)
    for (const entry of entries) {
      const upper = entry.vin.toUpperCase()
      if (seen.has(upper)) continue
      seen.add(upper)
      items.push({
        vin: entry.vin,
        brand: entry.brand,
        model: typeof entry.vehicle.model === "string" ? entry.vehicle.model : "",
        licensePlate: typeof entry.vehicle.licensePlate === "string" ? entry.vehicle.licensePlate : undefined,
        connected: entry.connected,
      })
    }
  }
  return items
}

export async function fetchFirstVehicleSnapshot(
  session: BMWSessionSecrets,
  targetVin?: string,
): Promise<VehicleSnapshot> {
  const allEntries: Array<{ vin: string; brand: "BMW" | "MINI"; vehicle: RawVehicle }> = []
  for (const brand of ["BMW", "MINI"] as const) {
    allEntries.push(...(await fetchVehicleEntries(session, brand)))
  }
  let selected = allEntries[0]
  if (targetVin && allEntries.length > 0) {
    const matched = allEntries.find(candidate => candidate.vin.toUpperCase() === targetVin.toUpperCase())
    if (matched) selected = matched
  }
  if (!selected) throw new Error("VEHICLE_LIST_EMPTY")
  const { vin, brand, vehicle } = selected
  const stateResponse = await requestJSON<{ state?: Record<string, any> }>("/eadrax-vcs/v4/vehicles/state", {
    method: "GET",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "bmw-vin": vin,
      "x-user-agent": brandUserAgent(brand),
    },
  })
  if (!stateResponse.state || typeof stateResponse.state !== "object") throw new Error("VEHICLE_STATE_INVALID")
  // 识别逻辑①：profile 的 driveTrain 直接字段（取不到时返回 unknown，交给用户手动覆盖兜底）
  const profile = await fetchVehicleProfile(session, vin, brand)
  const profileType = driveTypeFromProfile(profile)
  const snapshot = applyEnergyOverride(normalizeVehicle(vehicle, stateResponse.state, profileType))
  const consumption = await fetchConsumption(session, vin, snapshot.energy.type, brand)
  if (consumption) {
    snapshot.energy.consumption = consumption.value
    snapshot.energy.consumptionUnit = consumption.unit
  }
  // 保养提醒：即将到期/已到期的 CBS 保养项加入「需要关注」
  const maintenance = await fetchMaintenance(session, vin, brand)
  const maintenanceChecks = buildMaintenanceChecks(maintenance)
  if (maintenanceChecks.length > 0) {
    snapshot.checks = [...snapshot.checks, ...maintenanceChecks]
  }
  return snapshot
}
