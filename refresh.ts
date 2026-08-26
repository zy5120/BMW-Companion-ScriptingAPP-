import type { VehicleSnapshot } from "./domain"
import { fetchFirstVehicleSnapshot, renewSession } from "./bmw-client"
import { refreshMapSnapshot } from "./map-snapshot"
import { loadSession, saveSession } from "./session-vault"
import { loadSettings, saveConnectedSnapshot, setRuntimeMode } from "./storage"

// 连接态刷新唯一入口：车况页下拉刷新 / 首页刷新 / 组件定时刷新共用。
// 流程：续期 token（必要时）→ 拉取快照 → 落盘 + 切连接态 → 异步刷新组件地图。
// 失败向上抛出，由调用方决定回退策略（页面沿用旧数据 / 组件沿用旧快照）。
export async function refreshConnectedSnapshot(): Promise<VehicleSnapshot> {
  const session = loadSession()
  if (!session) throw new Error("SESSION_MISSING")
  let usable = session
  if (Date.parse(session.accessTokenExpiresAt) <= Date.now() + 60_000) {
    usable = await renewSession(session)
    saveSession(usable)
  }
  const next = await fetchFirstVehicleSnapshot(usable, loadSettings().selectedVin || undefined)
  saveConnectedSnapshot(next)
  setRuntimeMode("connected")
  // 自动生成停车位置地图快照（离屏渲染），供桌面大号组件使用；不阻塞主流程
  if (next.location) {
    void refreshMapSnapshot(next.location.latitude, next.location.longitude, next.identity.displayName)
  }
  return next
}
