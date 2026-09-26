import type { VehicleSnapshot } from "./domain"
import {
  fetchFirstVehicleSnapshot,
  isSessionExpiredError,
  loginWithPassword,
  renewSession,
} from "./bmw-client"
import { refreshMapSnapshot } from "./map-snapshot"
import { loadCredentials, loadSession, saveSession, type BMWSessionSecrets } from "./session-vault"
import { loadSettings, saveConnectedSnapshot, setRuntimeMode } from "./storage"

// 连接态刷新唯一入口：车况页下拉刷新 / 首页刷新 / 组件定时刷新共用。
// 流程：按需续期 → 拉取快照 → 落盘 + 切连接态 → 异步刷新组件地图。
// 凭证失效时自愈（见 recoverSession）；失败向上抛出，由调用方决定回退策略。

// 快过期（60 秒内）时续期，否则直接用现有 access token
async function withFreshToken(session: BMWSessionSecrets): Promise<BMWSessionSecrets> {
  if (Date.parse(session.accessTokenExpiresAt) > Date.now() + 60_000) return session
  const next = await renewSession(session)
  saveSession(next)
  return next
}

// 凭证失效时尽力恢复：
//   ① 先强制续期（refresh_token 还有效时最省事）
//   ② 续期被拒 → 密码登录的账号用本机保存的账号密码自动重新登录（用户无感）
//   ③ 验证码登录（没有保存密码）→ 抛 SESSION_EXPIRED，由界面提示「登录已过期，请重新登录」
async function recoverSession(session: BMWSessionSecrets): Promise<BMWSessionSecrets> {
  try {
    const renewed = await renewSession(session)
    saveSession(renewed)
    return renewed
  } catch (error) {
    if (!isSessionExpiredError(error)) throw error
  }

  const credentials = loadCredentials()
  if (credentials && credentials.loginMethod === "password" && credentials.password) {
    // 自动重登失败时抛出原始错误（如「账户已被锁定…」），让界面显示服务端说明
    const relogged = await loginWithPassword(credentials.mobile, credentials.password)
    saveSession(relogged)
    return relogged
  }

  throw new Error("SESSION_EXPIRED")
}

async function persistSnapshot(session: BMWSessionSecrets): Promise<VehicleSnapshot> {
  const next = await fetchFirstVehicleSnapshot(session, loadSettings().selectedVin || undefined)
  saveConnectedSnapshot(next)
  setRuntimeMode("connected")
  // 自动生成停车位置地图快照（离屏渲染），供桌面大号组件使用；不阻塞主流程
  if (next.location) {
    void refreshMapSnapshot(next.location.latitude, next.location.longitude, next.identity.displayName)
  }
  return next
}

export async function refreshConnectedSnapshot(): Promise<VehicleSnapshot> {
  const session = loadSession()
  if (!session) throw new Error("SESSION_MISSING")
  try {
    return await persistSnapshot(await withFreshToken(session))
  } catch (error) {
    // 时间未到但服务端已拒绝（token 被吊销 / refresh_token 失效）→ 自愈后重试一次
    if (!isSessionExpiredError(error)) throw error
    return await persistSnapshot(await recoverSession(session))
  }
}
