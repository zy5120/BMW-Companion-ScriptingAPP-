// 版本号与更新日志（用于「更新展示」sheet 与设置页版本号）
export const CURRENT_VERSION = "0.2.10"

export interface VersionNote {
  version: string
  title: string
  notes: string[]
}

// 按新→旧排列，最多保留近 5 条（slice 兜底，超出自动截断；发版时也建议删除最旧条目）。
// 新增版本时在顶部加一条，并把 CURRENT_VERSION 同步更新。
export const CHANGELOG: VersionNote[] = [
  {
    version: "0.2.10",
    title: "地图居中、MINI 图标与定位两行",
    notes: [
      "车况页地图在车辆换位置后自动居中",
      "MINI 车辆在组件中显示 MINI 图标",
      "组件定位地址支持两行显示（中号/大号）",
    ],
  },
  {
    version: "0.2.9",
    title: "大号小组件地图同步深色",
    notes: [
      "大号组件底部地图随系统深浅色/深色开关显示深色地图",
    ],
  },
  {
    version: "0.2.8",
    title: "优化车辆类型识别逻辑",
    notes: [
      "车辆类型改为直接读取车辆档案的 driveTrain 字段，识别更准确",
      "纯电车不会再被误判成混动车",
    ],
  },
  {
    version: "0.2.7",
    title: "车型识别与深色组件",
    notes: [
      "修复部分纯电车被误判成混动的问题",
      "能源类型识别不准时可手动切换（点击车况页蓝色卡片）",
      "新增「浅色模式下也显示深色背景」开关",
    ],
  },
  {
    version: "0.2.6",
    title: "界面展示优化",
    notes: [
      "关于页点版本号可查看更新日志",
      "更新日志最多展示近 5 条",
      "底部新增免费与反售卖提示",
    ],
  },
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
].slice(0, 5)

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
