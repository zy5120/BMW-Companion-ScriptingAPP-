// 版本号与更新日志（用于「更新展示」sheet 与设置页版本号）
export const CURRENT_VERSION = "0.2.5"

export interface VersionNote {
  version: string
  title: string
  notes: string[]
}

// 按新→旧排列。新增版本时在顶部加一条，并把 CURRENT_VERSION 同步更新。
export const CHANGELOG: VersionNote[] = [
  {
    version: "0.2.5",
    title: "更新提示与自动刷新",
    notes: [
      "版本更新后首次进入会弹出更新内容，下滑即可关闭",
      "打开首页自动刷新车况（5 分钟内不重复刷新，省电省流量）",
    ],
  },
  {
    version: "0.2.4",
    title: "登录体验优化",
    notes: [
      "登录更方便：手机号会自动记住，下次不用重新输入",
      "首次登录会弹窗说明，点「我同意」才能继续",
      "登录成功后自动隐藏登录入口，防止误触",
      "已登录状态显示更清楚",
      "验证服务支持自定义切换（默认即可，一般不用改）",
    ],
  },
  {
    version: "0.2.3",
    title: "显示优化",
    notes: [
      "燃油车剩余油量统一显示百分比，不再缺数据",
      "中号/大号组件油耗不再显示 /100km",
      "车况页刷新状态提示优化",
    ],
  },
]

// 版本号比较：a > b 返回 true（如 0.2.10 > 0.2.9）
export function versionNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na > nb
  }
  return false
}
