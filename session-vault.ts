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
