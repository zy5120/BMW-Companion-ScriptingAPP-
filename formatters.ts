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
  driving?: boolean
}

// 锁车状态唯一来源：车况页卡片、详情页、小组件共用同一逻辑
// 统一文案：已上锁 / 已解锁 / 锁车状态未知；车辆行驶中则显示“行驶中”
export function lockInfo(snapshot: { access: { lock: LockState }; driving?: boolean }): LockInfo {
  if (snapshot.driving) return { text: "行驶中", locked: false, unknown: false, driving: true }
  if (snapshot.access.lock === "unknown") return { text: "锁车状态未知", locked: false, unknown: true }
  const locked = snapshot.access.lock === "locked"
  return { text: locked ? "已上锁" : "已解锁", locked, unknown: false }
}

export function knownStateLabel(value: KnownState, subject: string): string {
  if (value === "closed") return `${subject}已关闭`
  if (value === "open") return `${subject}未关闭`
  return `${subject}状态未知`
}

// 车门/车窗关键提醒（车况页安全卡小字与中号/大号组件状态胶囊共用同一逻辑，不判断锁车）
// 全关→「门窗均已关闭」；多个未关→「多个车门/车窗未关闭」；单个未关→写出具体位置
export function doorWindowStatus(snapshot: VehicleSnapshot): { safe: boolean; text: string } {
  const a = snapshot.access
  const doors = a.doorStates
  const windows = a.windowStates
  // 先判断两门/四门：车门后排（左后/右后）都 unknown → 两门车；只有两门车才忽略后排
  const twoDoorDoors = Boolean(doors && doors.leftRear === "unknown" && doors.rightRear === "unknown")
  const twoDoorWindows = Boolean(windows && windows.leftRear === "unknown" && windows.rightRear === "unknown")
  const doorOpen: string[] = []
  const windowOpen: string[] = []
  if (doors) {
    if (doors.leftFront === "open") doorOpen.push("左前车门")
    if (doors.rightFront === "open") doorOpen.push("右前车门")
    if (!twoDoorDoors) {
      if (doors.leftRear === "open") doorOpen.push("左后车门")
      if (doors.rightRear === "open") doorOpen.push("右后车门")
    }
  }
  if (windows) {
    if (windows.leftFront === "open") windowOpen.push("左前车窗")
    if (windows.rightFront === "open") windowOpen.push("右前车窗")
    if (!twoDoorWindows) {
      if (windows.leftRear === "open") windowOpen.push("左后车窗")
      if (windows.rightRear === "open") windowOpen.push("右后车窗")
    }
  }
  const messages: string[] = []
  if (doorOpen.length === 1) messages.push(`${doorOpen[0]}未关闭`)
  else if (doorOpen.length > 1) messages.push("多个车门未关闭")
  if (windowOpen.length === 1) messages.push(`${windowOpen[0]}未关闭`)
  else if (windowOpen.length > 1) messages.push("多个车窗未关闭")
  if (messages.length > 0) return { safe: false, text: messages.join(" · ") }
  // 无细化状态时回退合并状态
  if (!doors && !windows) {
    if (a.doors === "open" || a.windows === "open") return { safe: false, text: "有门窗未关闭" }
    if (a.doors === "unknown" && a.windows === "unknown") return { safe: false, text: "门窗状态未知" }
  }
  // 部分未知：两门车只看前排，四门车前排/后排都算
  const hasUnknown =
    (doors ? (doors.leftFront === "unknown" || doors.rightFront === "unknown" || (!twoDoorDoors && (doors.leftRear === "unknown" || doors.rightRear === "unknown"))) : false) ||
    (windows ? (windows.leftFront === "unknown" || windows.rightFront === "unknown" || (!twoDoorWindows && (windows.leftRear === "unknown" || windows.rightRear === "unknown"))) : false)
  if (hasUnknown) return { safe: false, text: "部分门窗状态未知" }
  return { safe: true, text: "门窗均已关闭" }
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
