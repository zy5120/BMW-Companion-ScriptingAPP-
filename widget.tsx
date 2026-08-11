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
const CARD_BG = { light: "#F6F8FC", dark: "#111827" } as any
const SUB_BG = "tertiarySystemBackground"

function deepLink(route: "overview" | "status" | "location"): string {
  return Script.createRunURLScheme("BMW Companion", { route })
}

// ---------- 参考脚本同款展示小工具 ----------

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
  if (liters && percent) return `${liters}/${percent}`
  return liters || percent || "—"
}

function consumptionText(snapshot: VehicleSnapshot): string {
  if (snapshot.energy.consumption == null) return "—"
  return `${snapshot.energy.consumption}${snapshot.energy.consumptionUnit ? ` ${snapshot.energy.consumptionUnit}` : ""}`
}

// 官方车辆图片：需要 VIN + 有效 token（Keychain，同一脚本作用域）。
// 参考脚本 getBmwOfficialImage：eadrax-ics/v3/presentation/vehicles/{vin}/images?carView=VehicleStatus
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
  return "label"
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

function CarView({ car }: { car: UIImage | null }) {
  return (
    <ZStack frame={{ maxWidth: Infinity, maxHeight: 108 }}>
      {car ? (
        <Image image={car} resizable scaleToFit frame={{ maxWidth: Infinity, maxHeight: 108 }} />
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
      background={SUB_BG}
      clipShape={{ type: "rect", cornerRadius: 7 }}
    >
      <Image systemName={icon} font={10} foregroundStyle={color as any} />
      <Text font={10} fontWeight="semibold" foregroundStyle={color as any}>{info.text}</Text>
      {showUpdate ? <Text font={9} foregroundStyle="secondaryLabel">{formatSyncTime(snapshot.vehicleObservedAt)}</Text> : null}
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
      <Text font={9} foregroundStyle="secondaryLabel">{label}</Text>
      <Spacer minLength={0} />
      <Text font={10} fontWeight="semibold" foregroundStyle={tirePairColor(tire?.status)}>
        {tire?.pressureBar != null ? tire.pressureBar.toFixed(1) : "—"}
      </Text>
    </HStack>
  )
}

// ---------- 锁屏矩形（参考 renderRectangular） ----------

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
        <Text font="caption2" foregroundStyle="secondaryLabel">{fuelLevelText(snapshot)}</Text>
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

// ---------- 小号（参考 renderSmall） ----------

function SmallWidget({ snapshot, car }: { snapshot: VehicleSnapshot; car: UIImage | null }) {
  const info = lockInfo(snapshot)
  const lockColor = info.unknown ? "#8E8E93" : info.locked ? "#30D158" : "#FF453A"
  const lockIcon = info.locked ? "lock.shield.fill" : "xmark.shield.fill"
  const model = snapshot.identity.model ?? snapshot.identity.displayName
  return (
    <VStack
      alignment="leading"
      spacing={6}
      padding={12}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={CARD_BG}
    >
      {/* 第一行：车型 + 右上角锁状态 */}
      <HStack spacing={6}>
        <Text font="subheadline" fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
          {model}
        </Text>
        <Spacer minLength={0} />
        <Image systemName={lockIcon} font={14} foregroundStyle={lockColor as any} />
      </HStack>
      {/* 副标题：当前燃油量 */}
      <HStack spacing={4}>
        <Image systemName="fuelpump.fill" font={9} foregroundStyle={ACCENT} />
        <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {fuelLevelText(snapshot)}
        </Text>
      </HStack>
      {/* 车辆图片（占据中间剩余空间） */}
      <Spacer minLength={0} />
      <CarView car={car} />
      {/* 右下角：更新时间 */}
      <HStack>
        <Spacer minLength={0} />
        <Text font={9} foregroundStyle="secondaryLabel">{formatSyncTime(snapshot.vehicleObservedAt)}</Text>
      </HStack>
    </VStack>
  )
}

// ---------- 中号（参考 renderMedium） ----------

function MediumRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <HStack spacing={4} frame={{ maxWidth: Infinity, alignment: "leading" }}>
      <Image systemName={icon} font={9} foregroundStyle={ACCENT} frame={{ width: 13 }} />
      <Text font={8} foregroundStyle="secondaryLabel">{label}</Text>
      <Spacer minLength={0} />
      <Text font={9} fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>{value}</Text>
    </HStack>
  )
}

function MediumWidget({ snapshot, car, privacy }: {
  snapshot: VehicleSnapshot
  car: UIImage | null
  privacy: boolean
}) {
  const dw = doorWindowStatus(snapshot)
  return (
    <HStack
      spacing={14}
      padding={14}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "leading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={CARD_BG}
    >
      {/* 左半边（60%）：全部车况参数，两列网格排布；填满高度，末两行压到底部与右侧状态对齐 */}
      <VStack alignment="leading" spacing={4} frame={{ width: 172, maxHeight: Infinity, alignment: "topLeading" }}>
        <Text font="title3" fontWeight="bold" lineLimit={1} minScaleFactor={0.6}>
          {snapshot.identity.displayName}
        </Text>
        {/* 两列：里程 | 续航 */}
        <HStack spacing={10} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          <MediumRow icon="gauge.with.dots.needle.67percent" label="里程" value={snapshot.mileageKm != null ? `${snapshot.mileageKm.toLocaleString()}㎞` : "—"} />
          <MediumRow icon="map" label="续航" value={snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}㎞` : "—㎞"} />
        </HStack>
        {/* 两列：油量 | 油耗 */}
        <HStack spacing={10} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          <MediumRow icon="fuelpump.fill" label="油量" value={fuelLevelText(snapshot)} />
          <MediumRow icon="flame.fill" label="油耗" value={snapshot.energy.consumption != null ? `${snapshot.energy.consumption} L` : "—"} />
        </HStack>
        {/* 胎压 2×2：左前|右前 / 左后|右后 */}
        {snapshot.tires ? (
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: Infinity, alignment: "leading" }}>
            <HStack spacing={10} frame={{ maxWidth: Infinity, alignment: "leading" }}>
              <TirePair label="左前" tire={snapshot.tires?.frontLeft} />
              <TirePair label="右前" tire={snapshot.tires?.frontRight} />
            </HStack>
            <HStack spacing={10} frame={{ maxWidth: Infinity, alignment: "leading" }}>
              <TirePair label="左后" tire={snapshot.tires?.rearLeft} />
              <TirePair label="右后" tire={snapshot.tires?.rearRight} />
            </HStack>
          </VStack>
        ) : null}
        {/* 弹性空隙：把下方行压到组件底部，与右侧状态标签同一行 */}
        <Spacer minLength={0} />
        {/* 更新时间 */}
        <MediumRow icon="clock.fill" label="更新" value={formatSyncTime(snapshot.vehicleObservedAt)} />
        {/* 车辆定位信息 */}
        <MediumRow icon="location.fill" label="位置" value={privacy ? "位置已隐藏" : (snapshot.location?.address ?? "位置不可用")} />
      </VStack>
      {/* 右半边（40%）：车辆配图 + 右下角门窗/天窗状态；内容底部对齐 */}
      <VStack alignment="center" spacing={4} frame={{ width: 115, maxHeight: Infinity, alignment: "bottom" }}>
        <Spacer minLength={0} />
        <CarView car={car} />
        <HStack spacing={3}>
          <Image
            systemName={dw.safe ? "checkmark.shield.fill" : "exclamationmark.triangle.fill"}
            font={9}
            foregroundStyle={(dw.safe ? "#30D158" : "#FF9F0A") as any}
          />
          <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1}>{dw.text}</Text>
        </HStack>
      </VStack>
    </HStack>
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
      <Text font={7} foregroundStyle="secondaryLabel">{label}</Text>
    </VStack>
  )
}

function TireCell({ label, tire }: { label: string; tire?: { pressureBar?: number; status?: string } }) {
  return (
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: Infinity, alignment: "leading" }}>
      <Text font={7} foregroundStyle="secondaryLabel">{label}</Text>
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

function LargeWidget({ snapshot, logo, mapImage, privacy }: {
  snapshot: VehicleSnapshot
  logo: UIImage | null
  mapImage: UIImage | null
  privacy: boolean
}) {
  const freshness = getFreshness(snapshot)
  return (
    <VStack
      alignment="leading"
      spacing={6}
      padding={10}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={CARD_BG}
    >
      {/* 头部：车名（留白防裁切）+ 车牌 + 锁车 + logo */}
      <HStack spacing={6} frame={{ maxWidth: Infinity, alignment: "leading" }}>
        <Text font="title3" fontWeight="bold" lineLimit={1} minScaleFactor={0.5} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          {snapshot.identity.displayName}
        </Text>
        <Spacer minLength={0} />
        {snapshot.identity.plateMasked ? (
          <Text font={8} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.6}>{snapshot.identity.plateMasked}</Text>
        ) : null}
        <LockBadge snapshot={snapshot} />
        <LogoView logo={logo} size={18} />
      </HStack>

      {/* 信息卡：左 1/3 胎压 2×2（左上右上下左右下），右 2/3 油量/能耗/续航/总里程 */}
      <HStack spacing={10} padding={9} background={SUB_BG} clipShape={{ type: "rect", cornerRadius: 12 }} frame={{ maxWidth: Infinity, alignment: "leading" }}>
        {snapshot.tires ? (
          <VStack alignment="leading" spacing={5} frame={{ width: 86, alignment: "leading" }}>
            <HStack spacing={10}>
              <TireCell label="左前" tire={snapshot.tires?.frontLeft} />
              <TireCell label="右前" tire={snapshot.tires?.frontRight} />
            </HStack>
            <HStack spacing={10}>
              <TireCell label="左后" tire={snapshot.tires?.rearLeft} />
              <TireCell label="右后" tire={snapshot.tires?.rearRight} />
            </HStack>
          </VStack>
        ) : null}
        <VStack alignment="leading" spacing={5} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          <HStack spacing={10}>
            <LargeStat icon="fuelpump.fill" value={fuelLevelText(snapshot)} label="油量" />
            <LargeStat icon="flame.fill" value={consumptionText(snapshot)} label="能耗" />
          </HStack>
          <HStack spacing={10}>
            <LargeStat icon="map" value={snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}㎞` : "—㎞"} label="续航" />
            <LargeStat icon="gauge.with.dots.needle.67percent" value={snapshot.mileageKm != null ? `${snapshot.mileageKm.toLocaleString()}㎞` : "—"} label="总里程" />
          </HStack>
        </VStack>
      </HStack>

      {/* 分隔线：车况信息 / 地理位置 */}
      <VStack frame={{ maxWidth: Infinity, height: 1 }} background={{ light: "#D1D1D6", dark: "#3A3A3C" } as any} />

      {/* 地图：静态快照（居中对齐；scaleToFill + 匹配宽高比快照，撑满无空隙且不撑宽） */}
      <Spacer minLength={0} />
      <HStack frame={{ maxWidth: Infinity, alignment: "center" }}>
        {!privacy && mapImage ? (
          <ZStack frame={{ maxWidth: Infinity, height: 220 }} clipShape={{ type: "rect", cornerRadius: 14 }}>
            <Image image={mapImage} resizable scaleToFill frame={{ maxWidth: Infinity, height: 220 }} />
          </ZStack>
        ) : (
          <VStack
            alignment="center"
            spacing={4}
            frame={{ maxWidth: Infinity, height: 220 }}
            background={SUB_BG}
            clipShape={{ type: "rect", cornerRadius: 14 }}
          >
            <Image systemName={privacy ? "eye.slash.fill" : "map.fill"} font={22} foregroundStyle="secondaryLabel" />
            <Text font={9} foregroundStyle="secondaryLabel">{privacy ? "地图已隐藏" : "位置不可用"}</Text>
          </VStack>
        )}
      </HStack>

      {/* 地址 + 数据状态（地图下方） */}
      <HStack spacing={3} frame={{ maxWidth: Infinity, alignment: "leading" }}>
        <Image systemName="location.fill" font={9} foregroundStyle="secondaryLabel" />
        <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          {privacy ? "位置已隐藏" : (snapshot.location?.address ?? "位置不可用")}
        </Text>
        <Spacer minLength={0} />
        <Image systemName="circle.fill" font={5} foregroundStyle={freshnessColor(freshness) as any} />
        <Text font={8} fontWeight="medium" foregroundStyle={freshnessColor(freshness) as any}>
          {freshnessLabel(freshness)}
        </Text>
      </HStack>
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

async function loadLogo(): Promise<UIImage | null> {
  try {
    const image = await Promise.race([
      UIImage.fromURL(LOGO_URL),
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
  // 组件每 30 分钟刷新一次：快照过旧时自动拉新数据（失败则沿用旧数据）
  if (loadRuntimeMode() === "connected") {
    snapshot = await refreshWidgetSnapshotIfStale(snapshot)
  }
  const parameter = parseWidgetParameter(Widget.parameter)
  const privacy = resolvePrivacy(parameter, loadSettings())
  const family = Widget.family
  const logo = await loadLogo()
  // 只有小号/中号需要车辆图；大号下半部分是静态地图快照
  const needsCar = family === "systemSmall" || family === "systemMedium"
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
      content = <MediumWidget snapshot={snapshot} car={car} privacy={privacy} />
      break
    case "systemLarge":
    case "systemExtraLarge":
      content = <LargeWidget snapshot={snapshot} logo={logo} mapImage={mapImage} privacy={privacy} />
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
