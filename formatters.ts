import type { Freshness, KnownState, LockState, VehicleSnapshot } from "./domain"

export function formatRelativeTime(iso?: string, now = Date.now()): string {
  if (!iso) return "时间未知"
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return "时间未知"
  const minutes = Math.max(0, Math.round((now - timestamp) / 60000))
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

// 车辆最近同步时间：当天显示 HH:mm更新，跨天显示 MM-dd HH:mm更新。
export function formatSyncTime(iso?: string, now = new Date()): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${sameDay ? hm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`}更新`
}

export function freshnessLabel(value: Freshness): string {
  switch (value) {
    case "fresh": return "数据最新"
    case "stale": return "显示上次数据"
    case "expired": return "数据已过期"
    case "invalid": return "数据不可用"
    default: return "尚无数据"
  }
}

export function freshnessColor(value: Freshness): string {
  switch (value) {
    case "fresh": return "#30D158"
    case "stale": return "#FF9F0A"
    case "expired": return "#FF453A"
    default: return "#8E8E93"
  }
}

export interface LockInfo {
  text: string
  locked: boolean
  unknown: boolean
}

// 锁车状态唯一来源：车况页卡片、详情页、小组件共用同一逻辑
// 统一文案：已上锁 / 已解锁 / 锁车状态未知
export function lockInfo(snapshot: { access: { lock: LockState } }): LockInfo {
  if (snapshot.access.lock === "unknown") return { text: "锁车状态未知", locked: false, unknown: true }
  const locked = snapshot.access.lock === "locked"
  return { text: locked ? "已上锁" : "已解锁", locked, unknown: false }
}

export function knownStateLabel(value: KnownState, subject: string): string {
  if (value === "closed") return `${subject}已关闭`
  if (value === "open") return `${subject}未关闭`
  return `${subject}状态未知`
}

export function safetySummary(snapshot: VehicleSnapshot): { safe: boolean; text: string } {
  const access = snapshot.access
  // 天窗（roof）状态很多车型不上报（返回 unknown），不应因此判“部分状态未知”；
  // 只在 roof === "open" 时才作为“有门窗未关闭”告警。
  const unknown = [access.lock, access.doors, access.windows].some(value => value === "unknown")
  if (unknown) return { safe: false, text: "部分状态未知" }
  if (access.lock !== "locked") return { safe: false, text: "车辆未锁" }
  if ([access.doors, access.windows, access.roof, access.hood, access.trunk].some(value => value === "open")) {
    return { safe: false, text: "有门窗未关闭" }
  }
  return { safe: true, text: "车辆安全" }
}

export function displayAddress(snapshot: VehicleSnapshot, privacy: boolean): string {
  if (!snapshot.location) return "位置不可用"
  return privacy ? "位置已隐藏" : snapshot.location.address ?? "地址不可用"
}
