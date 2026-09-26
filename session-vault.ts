export interface BMWSessionSecrets {
  schemaVersion: 1
  accessToken: string
  refreshToken: string
  gcid: string
  accessTokenExpiresAt: string
  issuedAt: string
  contractVersion: "5.14.0-compat"
}

const SESSION_KEY = "bmw.companion.v1.session"
const KEYCHAIN_OPTIONS = {
  accessibility: "first_unlock_this_device" as const,
  synchronizable: false,
}

function isSession(value: unknown): value is BMWSessionSecrets {
  if (!value || typeof value !== "object") return false
  const session = value as Partial<BMWSessionSecrets>
  return session.schemaVersion === 1 &&
    typeof session.accessToken === "string" &&
    session.accessToken.length > 20 &&
    typeof session.refreshToken === "string" &&
    session.refreshToken.length > 20 &&
    typeof session.gcid === "string" &&
    session.gcid.length > 3 &&
    typeof session.accessTokenExpiresAt === "string" &&
    Number.isFinite(Date.parse(session.accessTokenExpiresAt)) &&
    typeof session.issuedAt === "string" &&
    session.contractVersion === "5.14.0-compat"
}

export function loadSession(): BMWSessionSecrets | null {
  const raw = Keychain.get(SESSION_KEY, { synchronizable: false })
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return isSession(value) ? value : null
  } catch {
    return null
  }
}

export function saveSession(session: BMWSessionSecrets): void {
  if (!isSession(session)) throw new Error("SESSION_INVALID")
  const saved = Keychain.set(SESSION_KEY, JSON.stringify(session), KEYCHAIN_OPTIONS)
  if (!saved) throw new Error("SESSION_KEYCHAIN_WRITE_FAILED")
}

export function removeSession(): void {
  const removed = Keychain.remove(SESSION_KEY, { synchronizable: false })
  if (!removed && Keychain.contains(SESSION_KEY, { synchronizable: false })) {
    throw new Error("SESSION_KEYCHAIN_REMOVE_FAILED")
  }
}

export function hasUsableSession(now = Date.now()): boolean {
  const session = loadSession()
  return Boolean(session && Date.parse(session.accessTokenExpiresAt) > now + 60_000)
}

// —— 登录凭证（仅用于「登录过期时自动重新登录」）——
// 只当用户选择「密码登录」时才保存密码。
// 存储位置：系统 Keychain，且 **仅本机** ——
//   · synchronizable: false  → 不同步 iCloud 钥匙串（不上云）
//   · accessibility: first_unlock_this_device → 不随备份迁移到其他设备
// 登出时与 token 一并清除。
export type LoginMethod = "password" | "sms"

export interface BMWCredentials {
  schemaVersion: 1
  loginMethod: LoginMethod
  mobile: string
  // 仅 loginMethod === "password" 时存在
  password?: string
  savedAt: string
}

const CREDENTIALS_KEY = "bmw.companion.v1.credentials"

function isCredentials(value: unknown): value is BMWCredentials {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<BMWCredentials>
  if (record.schemaVersion !== 1) return false
  if (record.loginMethod !== "password" && record.loginMethod !== "sms") return false
  if (typeof record.mobile !== "string" || !/^86\d{11}$/.test(record.mobile)) return false
  if (record.loginMethod === "password" && (typeof record.password !== "string" || !record.password)) return false
  return true
}

export function loadCredentials(): BMWCredentials | null {
  const raw = Keychain.get(CREDENTIALS_KEY, { synchronizable: false })
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return isCredentials(value) ? value : null
  } catch {
    return null
  }
}

// 记录本次登录方式（及密码登录时的密码），供登录过期后自动重登。写入失败不影响登录本身。
export function saveCredentials(mobile: string, loginMethod: LoginMethod, password?: string): void {
  const record: BMWCredentials = loginMethod === "password" && password
    ? { schemaVersion: 1, loginMethod, mobile, password, savedAt: new Date().toISOString() }
    : { schemaVersion: 1, loginMethod, mobile, savedAt: new Date().toISOString() }
  try {
    Keychain.set(CREDENTIALS_KEY, JSON.stringify(record), KEYCHAIN_OPTIONS)
  } catch {
    // 忽略：仅影响自动重登能力
  }
}

export function removeCredentials(): void {
  try {
    if (Keychain.contains(CREDENTIALS_KEY, { synchronizable: false })) {
      Keychain.remove(CREDENTIALS_KEY, { synchronizable: false })
    }
  } catch {
    // 忽略
  }
}

// 能否自动重登（仅密码登录 + 已保存密码）
export function canAutoRelogin(): boolean {
  const record = loadCredentials()
  return Boolean(record && record.loginMethod === "password" && record.password)
}

export function makeSession(input: {
  accessToken: string
  refreshToken: string
  gcid: string
  expiresInSeconds?: number
  now?: Date
}): BMWSessionSecrets {
  const now = input.now ?? new Date()
  const expiresIn = Math.max(60, Math.min(input.expiresInSeconds ?? 3000, 86_400))
  return {
    schemaVersion: 1,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    gcid: input.gcid,
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    issuedAt: now.toISOString(),
    contractVersion: "5.14.0-compat",
  }
}
