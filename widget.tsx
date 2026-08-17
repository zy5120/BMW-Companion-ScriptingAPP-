import {
  fetch,
  HStack,
  Image,
  Link,
  Script,
  Spacer,
  Text,
  VStack,
  Widget,
  ZStack,
} from "scripting"
import type { VehicleSnapshot } from "./domain"
import { fetchFirstVehicleSnapshot, renewSession } from "./bmw-client"
import { BMW_HEADERS, BMW_HOST, brandUserAgent } from "./compat-config"
import { formatSyncTime } from "./formatters"
import { refreshMapSnapshot } from "./map-snapshot"
import { loadSession, saveSession } from "./session-vault"
import {
  getFreshness,
  loadRuntimeMode,
  loadSettings,
  loadWidgetSnapshot,
  parseWidgetParameter,
  resolvePrivacy,
  saveConnectedSnapshot,
  scriptKeyNamespace,
  setRuntimeMode,
} from "./storage"

const ACCENT = "#166DFF"
const LOGO_URL = "https://m.qqtlr.com/logo.png"
const MINI_LOGO_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/MINI_logo.svg/330px-MINI_logo.svg.png"
const CARD_BG = { light: "#F6F8FC", dark: "#111827" } as any
const SUB_BG = "tertiarySystemBackground"

// 强制深色背景：WidgetKit 里 preferredColorScheme 不生效（小组件只能跟随系统深浅色），
// 因此手动把背景色与系统自适应文字色替换为深色值。
let FORCE_DARK = false

function setForceDark(value: boolean): void {
  FORCE_DARK = value
}

function darkColor(name: string): any {
  if (!FORCE_DARK) return name
  switch (name) {
    case "label": return "#FFFFFF"
    case "secondaryLabel": return "rgba(235,235,245,0.6)"
    case "tertiaryLabel": return "rgba(235,235,245,0.3)"
    case "secondarySystemBackground": return "#1C1C1E"
    case "tertiarySystemBackground": return "#2C2C2E"
    default: return name
  }
}

function widgetContainerBackground(): any {
  return FORCE_DARK ? { light: "#111827", dark: "#111827" } : CARD_BG
}

function deepLink(route: "overview" | "status" | "location"): string {
  return Script.createRunURLScheme("BMW MINI Linker", { route })
}

// ---------- 通用展示小工具 ----------

function lockInfo(snapshot: VehicleSnapshot): { text: string; locked: boolean; unknown: boolean } {
  if (snapshot.access.lock === "unknown") return { text: "锁车状态未知", locked: false, unknown: true }
  const locked = snapshot.access.lock === "locked"
  return { text: locked ? "已上锁" : "已解锁", locked, unknown: false }
}

function doorWindowStatus(snapshot: VehicleSnapshot): { safe: boolean; text: string } {
  const a = snapshot.access
  if (a.lock === "unknown") return { safe: false, text: "状态未知" }
  if (a.lock !== "locked") return { safe: false, text: "已解锁" }
  if (a.doors === "closed" && a.windows === "closed") {
    if (a.roof === "open") return { safe: false, text: "天窗未关闭" }
    if (a.hood === "open") return { safe: false, text: "引擎盖打开" }
    if (a.trunk === "open") return { safe: false, text: "后备箱打开" }
    return { safe: true, text: "门窗已关闭" }
  }
  return { safe: false, text: "门窗未关闭" }
}

function fuelLevelText(snapshot: VehicleSnapshot): string {
  const e = snapshot.energy
  const percent = e.levelPercent != null ? `${Math.round(e.levelPercent)}%` : ""
  const liters = e.remainingLiters != null ? `${Math.round(e.remainingLiters)}L` : ""
  // 燃油车剩余油量统一显示百分比（宝马接口的升数不一定返回，百分比总能取到）
  if (e.type === "fuel") return percent || liters || "—"
  if (liters && percent) return `${liters}/${percent}`
  return liters || percent || "—"
}

function consumptionText(snapshot: VehicleSnapshot): string {
  if (snapshot.energy.consumption == null) return "—"
  // 中号/大号组件空间有限，去掉“/100km”后缀（如 L/100km → L，kWh/100km → kWh；
  // 混动的字符串油耗同样去掉，如 “6.5 L/100km · 14.2 kWh/100km” → “6.5 L · 14.2 kWh”）。
  return `${snapshot.energy.consumption}${snapshot.energy.consumptionUnit ? ` ${snapshot.energy.consumptionUnit}` : ""}`.replace(/\/100km/g, "")
}

// 按车型返回“油量/电量”文本：燃油车→%，纯电车→%，混动车→L/%。
function energySecondaryText(snapshot: VehicleSnapshot): string {
  const e = snapshot.energy
  const liters = e.remainingLiters != null ? `${Math.round(e.remainingLiters)}L` : ""
  const percent = e.levelPercent != null ? `${Math.round(e.levelPercent)}%` : ""
  switch (e.type) {
    case "electric": return percent || "—"
    case "hybrid": return liters && percent ? `${liters}/${percent}` : liters || percent || "—"
    // 燃油车剩余油量显示百分比（宝马接口升数不一定返回，百分比总能取到），升数仅作兜底
    case "fuel": return percent || liters || "—"
    default: return liters || percent || "—"
  }
}

// 按车型返回能源图标：纯电→闪电，燃油/混动→加油机。
function energyIcon(snapshot: VehicleSnapshot): string {
  return snapshot.energy.type === "electric" ? "bolt.fill" : "fuelpump.fill"
}

// 官方车辆图片：需要 VIN + 有效 token（Keychain，同一脚本作用域）。
// 官方车辆图片：eadrax-ics/v3/presentation/vehicles/{vin}/images?carView=VehicleStatus
async function fetchOfficialCarImage(snapshot: VehicleSnapshot): Promise<UIImage | null> {
  try {
    const session = loadSession()
    if (!session || !snapshot.vin) return null
    let usable = session
    if (Date.parse(session.accessTokenExpiresAt) <= Date.now() + 60_000) {
      usable = await renewSession(session)
      saveSession(usable)
    }
    const url =
      `${BMW_HOST}/eadrax-ics/v3/presentation/vehicles/${encodeURIComponent(snapshot.vin)}/images?carView=VehicleStatus`
    const brand = snapshot.identity.brand?.toLowerCase() === "mini" ? "MINI" : "BMW"
    const response = await fetch(url, {
      method: "GET",
      headers: { ...BMW_HEADERS, "x-user-agent": brandUserAgent(brand), authorization: `Bearer ${usable.accessToken}` },
      timeout: 12,
      handleRedirect: async request => (request.url.startsWith(BMW_HOST) ? request : null),
      debugLabel: "official car image",
    })
    if (!response.ok) return null
    const data = await response.data()
    if (!data || data.size === 0) return null
    return UIImage.fromData(data)
  } catch (error) {
    console.warn("official car image unavailable:", error instanceof Error ? error.message : String(error))
    return null
  }
}

function tirePairColor(status?: string): any {
  if (status === "warning") return "#FF9F0A"
  if (status === "unknown") return "#8E8E93"
  return darkColor("label")
}

// ---------- 通用小部件 ----------

function LogoView({ logo, size = 20 }: { logo: UIImage | null; size?: number }) {
  if (logo) {
    return (
      <Image
        image={logo}
        resizable
        scaleToFit
        frame={{ width: size, height: size }}
      />
    )
  }
  return <Image systemName="car.2.fill" font={size - 6} foregroundStyle={ACCENT} />
}

function CarView({ car, maxHeight = 108 }: { car: UIImage | null; maxHeight?: number }) {
  return (
    <ZStack frame={{ maxWidth: Infinity, maxHeight }}>
      {car ? (
        <Image image={car} resizable scaleToFit frame={{ maxWidth: Infinity, maxHeight }} />
      ) : (
        <Image systemName="car.side.fill" font={46} foregroundStyle={ACCENT} />
      )}
    </ZStack>
  )
}

function LockRow({ snapshot, showUpdate = true }: { snapshot: VehicleSnapshot; showUpdate?: boolean }) {
  const info = lockInfo(snapshot)
  const color = info.unknown ? "#8E8E93" : info.locked ? "#30D158" : "#FF453A"
  const icon = info.locked ? "lock.shield.fill" : "xmark.shield.fill"
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 6, vertical: 4 }}
      background={darkColor(SUB_BG)}
      clipShape={{ type: "rect", cornerRadius: 7 }}
    >
      <Image systemName={icon} font={10} foregroundStyle={color as any} />
      <Text font={10} fontWeight="semibold" foregroundStyle={color as any}>{info.text}</Text>
      {showUpdate ? <Text font={9} foregroundStyle={darkColor("secondaryLabel")}>{formatSyncTime(snapshot.vehicleObservedAt)}</Text> : null}
      <Spacer minLength={0} />
      {snapshot.checks.length > 0 ? (
        <Image systemName="exclamationmark.triangle.fill" font={10} foregroundStyle="#FF9F0A" />
      ) : null}
    </HStack>
  )
}

function TirePair({ label, tire }: { label: string; tire?: { pressureBar?: number; status?: string } }) {
  return (
    <HStack spacing={3} frame={{ maxWidth: Infinity, alignment: "leading" }}>
      <Text font={9} foregroundStyle={darkColor("secondaryLabel")}>{label}</Text>
      <Spacer minLength={0} />
      <Text font={10} fontWeight="semibold" foregroundStyle={tirePairColor(tire?.status)}>
        {tire?.pressureBar != null ? tire.pressureBar.toFixed(1) : "—"}
      </Text>
    </HStack>
  )
}

// ---------- 锁屏矩形 ----------

function AccessoryRectangular({ snapshot, logo }: { snapshot: VehicleSnapshot; logo: UIImage | null }) {
  const info = lockInfo(snapshot)
  return (
    <VStack alignment="leading" spacing={3} widgetURL={deepLink("overview")} widgetAccentable>
      <HStack spacing={5}>
        <Text font="caption" fontWeight="semibold" lineLimit={1}>{snapshot.identity.displayName}</Text>
        <Spacer minLength={0} />
        <LogoView logo={logo} size={14} />
      </HStack>
      <HStack spacing={6} alignment="firstTextBaseline">
        <Text font="headline" fontWeight="bold">
          {snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}㎞` : "—㎞"}
        </Text>
        <Text font="caption2" foregroundStyle={darkColor("secondaryLabel")}>{fuelLevelText(snapshot)}</Text>
      </HStack>
      <HStack spacing={4}>
        <Image
          systemName={info.locked ? "lock.shield.fill" : "xmark.shield.fill"}
          font={9}
          foregroundStyle={(info.locked ? "#30D158" : "#FF453A") as any}
        />
        <Text font="caption2" lineLimit={1}>{info.text} · {formatSyncTime(snapshot.vehicleObservedAt)}</Text>
      </HStack>
    </VStack>
  )
}

// ---------- 小号 ----------

function SmallWidget({ snapshot, car }: { snapshot: VehicleSnapshot; car: UIImage | null }) {
  const info = lockInfo(snapshot)
  const lockColor = info.unknown ? "#8E8E93" : info.locked ? "#30D158" : "#FF453A"
  const lockIcon = info.locked ? "lock.shield.fill" : "xmark.shield.fill"
  const model = snapshot.identity.model ?? snapshot.identity.displayName
  const rangeText = snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}km` : "—km"
  const fuelText = energySecondaryText(snapshot)
  return (
    <VStack
      alignment="leading"
      spacing={6}
      padding={12}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={widgetContainerBackground()}
      foregroundStyle={darkColor("label")}
    >
      {/* 第一行：车型 + 右上角锁状态 */}
      <HStack spacing={6}>
        <Text font="title3" fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
          {model}
        </Text>
        <Spacer minLength={0} />
        <Image systemName={lockIcon} font={14} foregroundStyle={lockColor as any} />
      </HStack>
      {/* 副标题：剩余里程 + 油量/电量，如 500km/35L 或 500km/80% */}
      <HStack spacing={4}>
        <Image systemName={energyIcon(snapshot)} font={9} foregroundStyle={ACCENT} />
        <Text font="caption" foregroundStyle={darkColor("secondaryLabel")} lineLimit={1} minScaleFactor={0.8}>
          {`${rangeText}/${fuelText}`}
        </Text>
      </HStack>
      {/* 车辆图片（占据中间剩余空间） */}
      <Spacer minLength={0} />
      <CarView car={car} />
      {/* 右下角：更新时间 */}
      <HStack>
        <Spacer minLength={0} />
        <Text font={9} foregroundStyle={darkColor("secondaryLabel")}>{formatSyncTime(snapshot.vehicleObservedAt)}</Text>
      </HStack>
    </VStack>
  )
}

// ---------- 中号 ----------

function MediumRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <HStack spacing={4} frame={{ maxWidth: Infinity, alignment: "leading" }}>
      <Image systemName={icon} font={9} foregroundStyle={ACCENT} frame={{ width: 13 }} />
      <Text font={8} foregroundStyle={darkColor("secondaryLabel")}>{label}</Text>
      <Spacer minLength={0} />
      <Text font={9} fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>{value}</Text>
    </HStack>
  )
}

// 车况行：图标靠左、数值靠右（无文字标签，图标即可示意）
function StatCard({ icon, value, tone }: { icon: string; value: string; tone?: string }) {
  return (
    <HStack spacing={3} frame={{ maxWidth: Infinity, alignment: "leading" }}>
      <Image systemName={icon} font={9} foregroundStyle={ACCENT} frame={{ width: 13 }} />
      <Spacer minLength={0} />
      <Text font={10} fontWeight="semibold" lineLimit={1} minScaleFactor={0.6} foregroundStyle={darkColor(tone ?? "label")}>{value}</Text>
    </HStack>
  )
}

// 状态胶囊：绿=正常 / 橙=异常
function StatusPill({ safe, text }: { safe: boolean; text: string }) {
  const color = safe ? "#30D158" : "#FF9F0A"
  const icon = safe ? "checkmark.shield.fill" : "exclamationmark.triangle.fill"
  return (
    <HStack spacing={3} padding={{ horizontal: 7, vertical: 3 }} background={`${color}1A` as any} clipShape={{ type: "capsule", style: "continuous" }}>
      <Image systemName={icon} font={9} foregroundStyle={color as any} />
      <Text font={9} fontWeight="semibold" foregroundStyle={color as any} lineLimit={1}>{text}</Text>
    </HStack>
  )
}

// 中号与大号共用：头部 + 左信息 + 右车图。fill=true 时填满可用高度（中号），false 时紧凑（大号顶部）。
function StatusBoard({ snapshot, logo, car, privacy, fill }: {
  snapshot: VehicleSnapshot
  logo: UIImage | null
  car: UIImage | null
  privacy: boolean
  fill: boolean
}) {
  const dw = doorWindowStatus(snapshot)
  const isAllGood = dw.safe && snapshot.checks.length === 0
  const settings = loadSettings()
  const h = fill ? { maxHeight: Infinity } : {}
  return (
    <VStack spacing={8} frame={{ maxWidth: Infinity, alignment: "topLeading" }}>
      {/* 头部：车型 + 车牌 + logo（整行） */}
      <HStack spacing={6} frame={{ maxWidth: Infinity, alignment: "leading" }}>
        <Text font="title3" fontWeight="bold" lineLimit={1} minScaleFactor={0.6}>
          {snapshot.identity.displayName}
        </Text>
        <Spacer minLength={0} />
        {snapshot.identity.plate || snapshot.identity.plateMasked ? (
          <Text font={8} foregroundStyle={darkColor("secondaryLabel")} lineLimit={1} minScaleFactor={0.6}>{snapshot.identity.plate ?? snapshot.identity.plateMasked ?? ""}</Text>
        ) : null}
        <LogoView logo={logo} size={16} />
      </HStack>

      {/* 主体：左信息 + 右车图 */}
      <HStack spacing={12} frame={{ maxWidth: Infinity, alignment: "leading", ...h }}>
        {/* 左列：车况 + 胎压 + 定位 + 刷新时间 */}
        <VStack alignment="leading" spacing={6} frame={{ width: 138, alignment: "topLeading", ...h }}>
          {/* 第一行：总里程 | 油耗 */}
          <HStack spacing={8} frame={{ maxWidth: Infinity, alignment: "leading" }}>
            <StatCard icon="gauge.with.dots.needle.67percent" value={snapshot.mileageKm != null ? `${snapshot.mileageKm.toLocaleString()}㎞` : "—"} />
            <StatCard icon="flame.fill" value={consumptionText(snapshot)} />
          </HStack>
          {/* 第二行：续航 | 油量/电量（按车型） */}
          <HStack spacing={8} frame={{ maxWidth: Infinity, alignment: "leading" }}>
            <StatCard icon="map" value={snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}㎞` : "—㎞"} />
            <StatCard icon={energyIcon(snapshot)} value={energySecondaryText(snapshot)} />
          </HStack>
          {/* 第三、四行：胎压 2×2（左上=左前 / 右上=右前 / 左下=左后 / 右下=右后） */}
          {snapshot.tires ? (
            <HStack spacing={8} frame={{ maxWidth: Infinity, alignment: "leading" }}>
              <VStack alignment="leading" spacing={3} frame={{ maxWidth: Infinity, alignment: "leading" }}>
                <TirePair label="左前" tire={snapshot.tires?.frontLeft} />
                <TirePair label="左后" tire={snapshot.tires?.rearLeft} />
              </VStack>
              <VStack alignment="leading" spacing={3} frame={{ maxWidth: Infinity, alignment: "leading" }}>
                <TirePair label="右前" tire={snapshot.tires?.frontRight} />
                <TirePair label="右后" tire={snapshot.tires?.rearRight} />
              </VStack>
            </HStack>
          ) : (settings.noTiresLine1 || settings.noTiresLine2) ? (
            <VStack alignment="leading" spacing={2}>
              {settings.noTiresLine1 ? <Text font={9} foregroundStyle={darkColor("secondaryLabel")} lineLimit={1}>{settings.noTiresLine1}</Text> : null}
              {settings.noTiresLine2 ? <Text font={9} foregroundStyle={darkColor("secondaryLabel")} lineLimit={1}>{settings.noTiresLine2}</Text> : null}
            </VStack>
          ) : null}
          {/* 第五行：定位 */}
          <HStack spacing={3} frame={{ maxWidth: Infinity, alignment: "leading" }}>
            <Image systemName="location.fill" font={9} foregroundStyle={darkColor("secondaryLabel")} />
            <Text font={9} foregroundStyle={darkColor("secondaryLabel")} lineLimit={2} frame={{ maxWidth: Infinity, height: 22, alignment: "leading" }}>{privacy ? "位置已隐藏" : (snapshot.location?.address ?? "位置不可用")}</Text>
          </HStack>
          {/* 弹性空隙：仅 fill（中号）时把最后一行压到底部；大号（紧凑）不需要 */}
          {fill ? <Spacer minLength={0} /> : null}
          {/* 第六行：刷新时间 + 锁车状态 */}
          <HStack spacing={3} frame={{ maxWidth: Infinity, alignment: "leading" }}>
            <Image systemName="clock.fill" font={9} foregroundStyle={darkColor("secondaryLabel")} />
            <Text font={9} foregroundStyle={darkColor("secondaryLabel")}>{formatSyncTime(snapshot.fetchedAt)}</Text>
            <Spacer minLength={0} />
            <LockBadge snapshot={snapshot} />
          </HStack>
        </VStack>

        {/* 右列：车辆图 + ALL GOOD 水印（全正常时）+ 状态胶囊（异常时） */}
        <ZStack frame={{ maxWidth: Infinity, ...h }} padding={{ leading: 5 }}>
          {isAllGood ? (
            <Text font="title2" fontWeight="bold" lineLimit={2} frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}>{"ALL\nGOOD"}</Text>
          ) : null}
          <VStack alignment="center" spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} padding={{ top: 10 }}>
            <CarView car={car} maxHeight={84} />
          </VStack>
          <HStack frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "bottom" }}>
            <Spacer minLength={0} />
            <StatusPill safe={dw.safe} text={dw.text} />
          </HStack>
        </ZStack>
      </HStack>
    </VStack>
  )
}

function MediumWidget({ snapshot, logo, car, privacy }: {
  snapshot: VehicleSnapshot
  logo: UIImage | null
  car: UIImage | null
  privacy: boolean
}) {
  return (
    <VStack
      spacing={0}
      padding={14}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={widgetContainerBackground()}
      foregroundStyle={darkColor("label")}
    >
      <StatusBoard snapshot={snapshot} logo={logo} car={car} privacy={privacy} fill />
    </VStack>
  )
}

// ---------- 大号（卡片式布局：标题 → 数据卡（左胎压/右车况）→ 地图 → 地址/数据状态） ----------

function LargeStat({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: Infinity, alignment: "leading" }}>
      <HStack spacing={3}>
        <Image systemName={icon} font={9} foregroundStyle={ACCENT} />
        <Text font={10} fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>{value}</Text>
      </HStack>
      <Text font={7} foregroundStyle={darkColor("secondaryLabel")}>{label}</Text>
    </VStack>
  )
}

function TireCell({ label, tire }: { label: string; tire?: { pressureBar?: number; status?: string } }) {
  return (
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: Infinity, alignment: "leading" }}>
      <Text font={7} foregroundStyle={darkColor("secondaryLabel")}>{label}</Text>
      <Text font={11} fontWeight="semibold" lineLimit={1} minScaleFactor={0.8} foregroundStyle={tirePairColor(tire?.status)}>
        {tire?.pressureBar != null ? tire.pressureBar.toFixed(1) : "—"}
      </Text>
    </VStack>
  )
}

function LockBadge({ snapshot }: { snapshot: VehicleSnapshot }) {
  const info = lockInfo(snapshot)
  const color = info.unknown ? "#8E8E93" : info.locked ? "#30D158" : "#FF453A"
  const icon = info.locked ? "lock.shield.fill" : "xmark.shield.fill"
  return (
    <HStack spacing={3} padding={{ horizontal: 7, vertical: 3 }} background={`${color}1A` as any} clipShape={{ type: "capsule", style: "continuous" }}>
      <Image systemName={icon} font={9} foregroundStyle={color as any} />
      <Text font={9} fontWeight="semibold" foregroundStyle={color as any}>{info.text}</Text>
    </HStack>
  )
}

function LargeWidget({ snapshot, logo, car, mapImage, privacy }: {
  snapshot: VehicleSnapshot
  logo: UIImage | null
  car: UIImage | null
  mapImage: UIImage | null
  privacy: boolean
}) {
  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={widgetContainerBackground()}
      foregroundStyle={darkColor("label")}
    >
      {/* 模块一：信息（与中号完全一致；高度 162 容纳两行地址，地图高度仍为 150 不变） */}
      <VStack spacing={8} padding={14} frame={{ maxWidth: Infinity, height: 162 }}>
        <StatusBoard snapshot={snapshot} logo={logo} car={car} privacy={privacy} fill />
      </VStack>

      {/* 弹性空隙：把地图压到组件底部 */}
      <Spacer minLength={0} />
      {/* 模块二：地图（高度 150，底部对齐） */}
      {!privacy && mapImage ? (
        <ZStack frame={{ maxWidth: Infinity, height: 150 }}>
          <Image image={mapImage} resizable scaleToFill frame={{ maxWidth: Infinity, height: 150 }} />
        </ZStack>
      ) : (
        <VStack
          alignment="center"
          spacing={4}
          frame={{ maxWidth: Infinity, height: 150 }}
          background={darkColor(SUB_BG)}
        >
          <Image systemName={privacy ? "eye.slash.fill" : "map.fill"} font={22} foregroundStyle={darkColor("secondaryLabel")} />
          <Text font={9} foregroundStyle={darkColor("secondaryLabel")}>{privacy ? "地图已隐藏" : "位置不可用"}</Text>
        </VStack>
      )}
    </VStack>
  )
}

function freshnessLabel(value: string): string {
  switch (value) {
    case "fresh": return "数据最新"
    case "stale": return "显示上次数据"
    case "expired": return "数据已过期"
    case "invalid": return "数据不可用"
    default: return "尚无数据"
  }
}

function freshnessColor(value: string): string {
  switch (value) {
    case "fresh": return "#30D158"
    case "stale": return "#FF9F0A"
    case "expired": return "#FF453A"
    default: return "#8E8E93"
  }
}

// 读取 App 在「停车位置」页/刷新时生成的 Apple 原生地图快照（App Group 共享目录，组件可读）
async function loadMapImage(): Promise<UIImage | null> {
  try {
    const path = `${FileManager.appGroupDocumentsDirectory}/car-location-map-${scriptKeyNamespace()}.png`
    return UIImage.fromFile(path)
  } catch {
    return null
  }
}

async function loadLogo(brand: "BMW" | "MINI" = "BMW"): Promise<UIImage | null> {
  try {
    // 按品牌加载对应 logo：MINI 用 MINI 图标，其余用 BMW
    const url = brand === "MINI" ? MINI_LOGO_URL : LOGO_URL
    const image = await Promise.race([
      UIImage.fromURL(url),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
    ])
    return image
  } catch {
    return null
  }
}

// 组件自动刷新：保存的快照超过 30 分钟 → 向 BMW 拉取最新车况（会话在 Keychain、nonce 同意在共享域，组件可访问）；
// 任何失败（离线/会话失效/接口错误）都回退到已有快照，保证组件永远有内容可显示。
async function refreshWidgetSnapshotIfStale(snapshot: VehicleSnapshot): Promise<VehicleSnapshot> {
  if (snapshot.source === "network") {
    const age = Date.now() - Date.parse(snapshot.cachedAt)
    if (Number.isFinite(age) && age < 30 * 60 * 1000) return snapshot
  }
  try {
    const session = loadSession()
    if (!session) return snapshot
    let usable = session
    if (Date.parse(session.accessTokenExpiresAt) <= Date.now() + 60_000) {
      usable = await renewSession(session)
      saveSession(usable)
    }
    const next = await fetchFirstVehicleSnapshot(usable, loadSettings().selectedVin || undefined)
    saveConnectedSnapshot(next)
    setRuntimeMode("connected")
    if (next.location) {
      void refreshMapSnapshot(next.location.latitude, next.location.longitude)
    }
    return next
  } catch {
    return snapshot
  }
}

async function main() {
  let snapshot = loadWidgetSnapshot()
  setForceDark(loadSettings().alwaysDarkBackground === true)
  // 组件每 30 分钟刷新一次：快照过旧时自动拉新数据（失败则沿用旧数据）
  if (loadRuntimeMode() === "connected") {
    snapshot = await refreshWidgetSnapshotIfStale(snapshot)
  }
  const parameter = parseWidgetParameter(Widget.parameter)
  const privacy = resolvePrivacy(parameter, loadSettings())
  const family = Widget.family
  const logo = await loadLogo(snapshot.identity.brand?.toLowerCase() === "mini" ? "MINI" : "BMW")
  // 小/中/大号都需要车辆图；大号顶部与中号一致，底部为地图快照
  const needsCar = family === "systemSmall" || family === "systemMedium" || family === "systemLarge" || family === "systemExtraLarge"
  const car = needsCar ? await fetchOfficialCarImage(snapshot) : null
  const mapImage = await loadMapImage()

  let content
  switch (family) {
    case "accessoryRectangular":
      content = <AccessoryRectangular snapshot={snapshot} logo={logo} />
      break
    case "systemSmall":
      content = <SmallWidget snapshot={snapshot} car={car} />
      break
    case "systemMedium":
      content = <MediumWidget snapshot={snapshot} logo={logo} car={car} privacy={privacy} />
      break
    case "systemLarge":
    case "systemExtraLarge":
      content = <LargeWidget snapshot={snapshot} logo={logo} car={car} mapImage={mapImage} privacy={privacy} />
      break
    default:
      content = <SmallWidget snapshot={snapshot} car={car} />
  }

  Widget.present(content, {
    reloadPolicy: { policy: "after", date: new Date(Date.now() + 30 * 60 * 1000) },
  })
  Script.exit()
}

void main()
