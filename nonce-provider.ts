import { fetch } from "scripting"
import {
  BMW_CLIENT,
  COMPAT_NONCE_HOST,
  COMPAT_NONCE_PATH,
} from "./compat-config"
import { createCompatProviderSignature } from "./compat-signature"
import { loadSettings, scriptKeyNamespace } from "./storage"
import type { NonceProviderId } from "./domain"

export type NoncePurpose = "login" | "refresh"

// —— 可插拔 nonce 提供方 ——
// 在「连接 BMW」页的登录验证服务中切换：默认服务 / 自定义地址（自建服务或测试）。
// 每个提供方都会把手机号/gcid 发送到对应服务换取 nonce，因此披露/同意按当前提供方区分。

function currentProvider(): NonceProviderId {
  return loadSettings().nonceProvider ?? "qqtlr"
}

function providerHost(provider: NonceProviderId): string {
  return provider === "custom"
    ? (loadSettings().customNonceUrl?.trim() || "自定义地址")
    : COMPAT_NONCE_HOST
}

export function getNonceDisclosure(): { providerId: string; host: string; message: string } {
  const provider = currentProvider()
  const host = providerHost(provider)
  return {
    providerId: `nonce-provider-${provider}`,
    host,
    message:
      "登录需要连接第三方辅助服务（非 BMW 官方）完成验证，过程中会把手机号等必要信息发送到该服务，可能留下访问记录；密码、短信验证码和登录凭证不会发送。",
  }
}

export interface NonceConsentRecord {
  schemaVersion: 1
  providerId: string
  disclosureVersion: 1
  acceptedAt: string
  acceptedHost: string
  dataClasses: ["mobile", "gcid", "client-version", "ip-and-request-metadata"]
}

// 组件拉取官方车辆实拍图时也需要 nonce 同意记录（独立扩展进程读不到插件私有存储），故保留共享；
// key 带脚本命名空间，避免多脚本互相覆盖。切换提供方后 acceptedHost 变化，需重新同意。
const NS = scriptKeyNamespace()
export const NONCE_CONSENT_KEY = `bmw.companion.v2.${NS}.nonceConsent`
const SHARED = { shared: true }

export function loadNonceConsent(): NonceConsentRecord | null {
  const disclosure = getNonceDisclosure()
  const value = Storage.get<NonceConsentRecord>(NONCE_CONSENT_KEY, SHARED)
  if (!value ||
      value.schemaVersion !== 1 ||
      value.providerId !== disclosure.providerId ||
      value.disclosureVersion !== 1 ||
      value.acceptedHost !== disclosure.host) return null
  return value
}

export function grantNonceConsent(): NonceConsentRecord {
  const disclosure = getNonceDisclosure()
  const record: NonceConsentRecord = {
    schemaVersion: 1,
    providerId: disclosure.providerId,
    disclosureVersion: 1,
    acceptedAt: new Date().toISOString(),
    acceptedHost: disclosure.host,
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

  switch (currentProvider()) {
    case "custom": return requestCustomNonce(normalized)
    default: return requestQqtlrNonce(normalized)
  }
}

// —— m.qqtlr.com ——
async function requestQqtlrNonce(normalized: string): Promise<string> {
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
    debugLabel: "BMW nonce qqtlr",
  })
  return parseNonceResponse(response)
}

// —— 自定义地址（自建服务 / 测试）——
async function requestCustomNonce(normalized: string): Promise<string> {
  const base = loadSettings().customNonceUrl?.trim()
  if (!base) throw new Error("NONCE_CUSTOM_URL_MISSING")
  const separator = base.includes("?") ? "&" : "?"
  const url = `${base}${separator}phone=${encodeURIComponent(normalized)}`
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "*/*" },
    timeout: 12,
    handleRedirect: async request => request.url.startsWith(base) ? request : null,
    debugLabel: "BMW nonce custom",
  })
  return parseNonceResponse(response)
}

// —— 响应解析：兼容 {code:0, data:"<nonce>"} 与直接返回 nonce 文本 ——
async function parseNonceResponse(response: {
  ok: boolean
  status: number
  text(): Promise<string>
}): Promise<string> {
  if (!response.ok) throw new Error(`NONCE_HTTP_${response.status}`)
  const raw = await response.text()
  if (raw.length > 8_192) throw new Error("NONCE_RESPONSE_TOO_LARGE")

  let nonce = raw.trim()
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && typeof parsed.data === "string") {
      if (parsed.code !== undefined && parsed.code !== 0) throw new Error("NONCE_PROVIDER_REJECTED")
      nonce = parsed.data.trim()
    }
  } catch (error) {
    if (error instanceof Error && error.message === "NONCE_PROVIDER_REJECTED") throw error
    // 非 JSON → 按纯文本 nonce 处理
  }

  if (!/^[0-9A-Za-z]+$/.test(nonce) || nonce.length < 64 || nonce.length > 1024) {
    throw new Error("NONCE_RESPONSE_INVALID")
  }
  return nonce
}
