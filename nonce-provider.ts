import { fetch } from "scripting"
import {
  BMW_CLIENT,
  COMPAT_NONCE_HOST,
  COMPAT_NONCE_PATH,
} from "./compat-config"
import { createCompatProviderSignature } from "./compat-signature"
import { scriptKeyNamespace } from "./storage"

export type NoncePurpose = "login" | "refresh"

export interface NonceConsentRecord {
  schemaVersion: 1
  providerId: "meidaisan-v5-compat"
  disclosureVersion: 1
  acceptedAt: string
  acceptedHost: string
  dataClasses: ["mobile", "gcid", "client-version", "ip-and-request-metadata"]
}

// 组件拉取官方车辆实拍图时也需要 nonce 同意记录（独立扩展进程读不到插件私有存储），故保留共享；
// key 带脚本命名空间，避免多脚本互相覆盖。
const NS = scriptKeyNamespace()
export const NONCE_CONSENT_KEY = `bmw.companion.v2.${NS}.nonceConsent.meidaisan-v5-compat`
const SHARED = { shared: true }

export const nonceDisclosure = {
  providerId: "meidaisan-v5-compat" as const,
  host: COMPAT_NONCE_HOST,
  path: COMPAT_NONCE_PATH,
  disclosureVersion: 1 as const,
  message:
    "登录需要连接一个第三方辅助服务（非 BMW 官方）完成验证。过程中会把手机号等必要信息发送到该服务，可能留下访问记录；密码、短信验证码和登录凭证不会发送。",
}

export function loadNonceConsent(): NonceConsentRecord | null {
  const value = Storage.get<NonceConsentRecord>(NONCE_CONSENT_KEY, SHARED)
  if (!value ||
      value.schemaVersion !== 1 ||
      value.providerId !== nonceDisclosure.providerId ||
      value.disclosureVersion !== nonceDisclosure.disclosureVersion ||
      value.acceptedHost !== nonceDisclosure.host) return null
  return value
}

export function grantNonceConsent(): NonceConsentRecord {
  const record: NonceConsentRecord = {
    schemaVersion: 1,
    providerId: nonceDisclosure.providerId,
    disclosureVersion: nonceDisclosure.disclosureVersion,
    acceptedAt: new Date().toISOString(),
    acceptedHost: nonceDisclosure.host,
    dataClasses: ["mobile", "gcid", "client-version", "ip-and-request-metadata"],
  }
  Storage.set(NONCE_CONSENT_KEY, record, SHARED)
  return record
}

export function revokeNonceConsent(): void {
  Storage.remove(NONCE_CONSENT_KEY, SHARED)
}

export async function requestCompatNonce(
  identifier: string,
  purpose: NoncePurpose,
): Promise<string> {
  if (!loadNonceConsent()) throw new Error("NONCE_CONSENT_REQUIRED")
  const normalized = identifier.trim()
  if (!normalized || normalized.length > 128 || /[\s&#?]/.test(normalized)) {
    throw new Error("NONCE_IDENTIFIER_INVALID")
  }
  if (purpose === "login" && !/^86\d{11}$/.test(normalized)) {
    throw new Error("NONCE_MOBILE_INVALID")
  }

  const signature = createCompatProviderSignature(normalized)
  const url = `${COMPAT_NONCE_HOST}${COMPAT_NONCE_PATH}` +
    `?phone=${encodeURIComponent(normalized)}` +
    `&k=${encodeURIComponent(signature)}&x=0`
  const response = await fetch(url, {
    method: "GET",
    headers: {
      xua: BMW_CLIENT.userAgent,
      fkthiefcopy: "Plagiarism/Copying/Server Runaway Interface Deadly Family",
      author: "MeiDaiSan",
    },
    timeout: 12,
    handleRedirect: async request => request.url.startsWith(COMPAT_NONCE_HOST) ? request : null,
    debugLabel: `BMW nonce ${purpose}`,
  })
  if (!response.ok) throw new Error(`NONCE_HTTP_${response.status}`)
  const raw = await response.text()
  if (raw.length > 8_192) throw new Error("NONCE_RESPONSE_TOO_LARGE")

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("NONCE_RESPONSE_NOT_JSON")
  }
  const result = parsed as { code?: unknown; data?: unknown }
  if (result.code !== 0 || typeof result.data !== "string") {
    throw new Error("NONCE_PROVIDER_REJECTED")
  }
  const nonce = result.data.trim()
  if (!/^[0-9A-Za-z]+$/.test(nonce) || nonce.length < 64 || nonce.length > 1024) {
    throw new Error("NONCE_RESPONSE_INVALID")
  }
  return nonce
}
