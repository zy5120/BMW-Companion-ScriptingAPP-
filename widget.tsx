import {
  fetch,
  HStack,
  Image,
  Link,
  Map,
  Marker,
  Script,
  Spacer,
  Text,
  VStack,
  Widget,
  ZStack,
} from "scripting"
import type { VehicleSnapshot } from "./domain"
import { renewSession } from "./bmw-client"
import { BMW_HEADERS, BMW_HOST } from "./compat-config"
import { formatSyncTime } from "./formatters"
import { loadSession, saveSession } from "./session-vault"
import {
  getFreshness,
  loadSettings,
  loadWidgetSnapshot,
  parseWidgetParameter,
  resolvePrivacy,
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
    if (a.roof === "closed") {
      if (a.hood === "open") return { safe: false, text: "引擎盖打开" }
      if (a.trunk === "open") return { safe: false, text: "后备箱打开" }
      return { safe: true, text: "门窗已关闭" }
    }
    return { safe: false, text: "天窗未关闭" }
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
    const response = await fetch(url, {
      method: "GET",
      headers: { ...BMW_HEADERS, authorization: `Bearer ${usable.accessToken}` },
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
    <ZStack frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
      {car ? (
        <Image image={car} resizable scaleToFit frame={{ maxWidth: Infinity, maxHeight: Infinity }} />
      ) : (
        <Image systemName="car.side.fill" font={40} foregroundStyle={ACCENT} />
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
    <HStack spacing={3}>
      <Text font={9} foregroundStyle="secondaryLabel">{label}</Text>
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

function SmallWidget({ snapshot, logo, car }: { snapshot: VehicleSnapshot; logo: UIImage | null; car: UIImage | null }) {
  return (
    <VStack
      alignment="leading"
      spacing={7}
      padding={12}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={CARD_BG}
    >
      <HStack spacing={6}>
        <Text font="subheadline" fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
          {snapshot.identity.displayName}
        </Text>
        <Spacer minLength={0} />
        <LogoView logo={logo} size={20} />
      </HStack>
      <HStack spacing={5} alignment="firstTextBaseline">
        <Text font={26} fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
          {snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}` : "—"}
        </Text>
        <Text font="caption" foregroundStyle="secondaryLabel">㎞</Text>
        <Spacer minLength={0} />
        <Text font="subheadline" foregroundStyle="secondaryLabel">{fuelLevelText(snapshot)}</Text>
      </HStack>
      <LockRow snapshot={snapshot} />
      <Spacer minLength={0} />
      <CarView car={car} />
    </VStack>
  )
}

// ---------- 中号（参考 renderMedium） ----------

function MediumWidget({ snapshot, logo, car, privacy }: {
  snapshot: VehicleSnapshot
  logo: UIImage | null
  car: UIImage | null
  privacy: boolean
}) {
  const dw = doorWindowStatus(snapshot)
  return (
    <HStack
      spacing={12}
      padding={14}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "leading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={CARD_BG}
    >
      <VStack alignment="leading" spacing={7} frame={{ maxWidth: Infinity, alignment: "leading" }}>
        <HStack spacing={6}>
          <Text font="subheadline" fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
            {snapshot.identity.displayName}
          </Text>
          <Spacer minLength={0} />
          {snapshot.identity.plateMasked ? (
            <Text font={9} foregroundStyle="secondaryLabel">{snapshot.identity.plateMasked}</Text>
          ) : null}
        </HStack>
        <HStack spacing={10}>
          <HStack spacing={3}>
            <Image systemName="gauge.with.dots.needle.67percent" font={10} foregroundStyle={ACCENT} />
            <Text font={10} fontWeight="semibold">
              {snapshot.mileageKm != null ? `${snapshot.mileageKm.toLocaleString()}㎞` : "—"}
            </Text>
          </HStack>
          <HStack spacing={3}>
            <Image systemName="map" font={10} foregroundStyle={ACCENT} />
            <Text font={10} fontWeight="semibold">
              {snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}㎞` : "—㎞"}
            </Text>
          </HStack>
        </HStack>
        <HStack spacing={10}>
          <HStack spacing={3}>
            <Image systemName="fuelpump.fill" font={10} foregroundStyle={ACCENT} />
            <Text font={10}>{fuelLevelText(snapshot)}</Text>
          </HStack>
          <HStack spacing={3}>
            <Image systemName="flame.fill" font={10} foregroundStyle={ACCENT} />
            <Text font={10}>{consumptionText(snapshot)}</Text>
          </HStack>
        </HStack>
        <HStack spacing={10}>
          <TirePair label="左前" tire={snapshot.tires?.frontLeft} />
          <TirePair label="右前" tire={snapshot.tires?.frontRight} />
          <TirePair label="左后" tire={snapshot.tires?.rearLeft} />
          <TirePair label="右后" tire={snapshot.tires?.rearRight} />
        </HStack>
        <LockRow snapshot={snapshot} />
        <HStack spacing={3}>
          <Image systemName="location.fill" font={9} foregroundStyle="secondaryLabel" />
          <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1}>
            {privacy ? "位置已隐藏" : (snapshot.location?.address ?? "位置不可用")}
          </Text>
          <Spacer minLength={0} />
        </HStack>
      </VStack>
      <VStack alignment="center" spacing={5} frame={{ width: 92, alignment: "center" }}>
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

// ---------- 大号（参考 renderLarge：中号信息 + 底部大图/状态） ----------

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
      spacing={10}
      padding={16}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      widgetURL={deepLink("overview")}
      widgetBackground={CARD_BG}
    >
      <HStack spacing={6}>
        <Text font="title3" fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
          {snapshot.identity.displayName}
        </Text>
        <Spacer minLength={0} />
        {snapshot.identity.plateMasked ? (
          <Text font={10} foregroundStyle="secondaryLabel">{snapshot.identity.plateMasked}</Text>
        ) : null}
        <LogoView logo={logo} size={22} />
      </HStack>
      <HStack spacing={16}>
        <HStack spacing={3}>
          <Image systemName="gauge.with.dots.needle.67percent" font={11} foregroundStyle={ACCENT} />
          <Text font={12} fontWeight="semibold">
            {snapshot.mileageKm != null ? `${snapshot.mileageKm.toLocaleString()}㎞` : "—"}
          </Text>
        </HStack>
        <HStack spacing={3}>
          <Image systemName="map" font={11} foregroundStyle={ACCENT} />
          <Text font={12} fontWeight="semibold">
            {snapshot.energy.rangeKm != null ? `${snapshot.energy.rangeKm}㎞` : "—㎞"}
          </Text>
        </HStack>
        <Spacer minLength={0} />
        <HStack spacing={3}>
          <Image systemName="fuelpump.fill" font={11} foregroundStyle={ACCENT} />
          <Text font={12}>{fuelLevelText(snapshot)}</Text>
        </HStack>
        <HStack spacing={3}>
          <Image systemName="flame.fill" font={11} foregroundStyle={ACCENT} />
          <Text font={12}>{consumptionText(snapshot)}</Text>
        </HStack>
      </HStack>
      <HStack spacing={14}>
        <TirePair label="左前" tire={snapshot.tires?.frontLeft} />
        <TirePair label="右前" tire={snapshot.tires?.frontRight} />
        <TirePair label="左后" tire={snapshot.tires?.rearLeft} />
        <TirePair label="右后" tire={snapshot.tires?.rearRight} />
        <Spacer minLength={0} />
        <LockRow snapshot={snapshot} showUpdate={false} />
      </HStack>
      <HStack spacing={3}>
        <Image systemName="location.fill" font={9} foregroundStyle="secondaryLabel" />
        <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1}>
          {privacy ? "位置已隐藏" : (snapshot.location?.address ?? "位置不可用")}
        </Text>
        <Spacer minLength={0} />
        <Text font={9} foregroundStyle={freshnessColor(freshness) as any}>{freshnessLabel(freshness)}</Text>
      </HStack>
      <Spacer minLength={0} />
      {!privacy && mapImage ? (
        <Link url={deepLink("location")}>
          <Image image={mapImage} resizable scaleToFit frame={{ maxWidth: Infinity, maxHeight: Infinity }} clipShape={{ type: "rect", cornerRadius: 14 }} />
        </Link>
      ) : (
        <Link url={deepLink("location")}>
          <VStack
            alignment="leading"
            spacing={4}
            padding={12}
            frame={{ maxWidth: Infinity, alignment: "leading" }}
            background={SUB_BG}
            clipShape={{ type: "rect", cornerRadius: 14 }}
          >
            <HStack spacing={4}>
              <Image systemName="location.fill" font={11} foregroundStyle={ACCENT} />
              <Text font={11} fontWeight="semibold">车辆停放位置</Text>
              <Spacer minLength={0} />
              <Text font={9} foregroundStyle="secondaryLabel">{formatSyncTime(snapshot.vehicleObservedAt)}</Text>
            </HStack>
            <Text font={10} foregroundStyle="secondaryLabel" lineLimit={2}>
              {privacy ? "位置已隐藏" : (snapshot.location?.address ?? "位置不可用")}
            </Text>
            <Text font={9} foregroundStyle="tertiaryLabel">点按打开原生地图</Text>
          </VStack>
        </Link>
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

// 读取 App 在「停车位置」页截图的 Apple 原生地图（App Group 共享目录，组件可读）
async function loadMapImage(): Promise<UIImage | null> {
  try {
    const path = `${FileManager.appGroupDocumentsDirectory}/car-location-map.png`
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

async function main() {
  const snapshot = loadWidgetSnapshot()
  const parameter = parseWidgetParameter(Widget.parameter)
  const privacy = resolvePrivacy(parameter, loadSettings())
  const family = Widget.family
  const logo = await loadLogo()
  // 只有小号/中号需要车辆图；大号底部是地图截图或位置卡片
  const needsCar = family === "systemSmall" || family === "systemMedium"
  const car = needsCar ? await fetchOfficialCarImage(snapshot) : null
  const mapImage = await loadMapImage()

  let content
  switch (family) {
    case "accessoryRectangular":
      content = <AccessoryRectangular snapshot={snapshot} logo={logo} />
      break
    case "systemSmall":
      content = <SmallWidget snapshot={snapshot} logo={logo} car={car} />
      break
    case "systemMedium":
      content = <MediumWidget snapshot={snapshot} logo={logo} car={car} privacy={privacy} />
      break
    case "systemLarge":
    case "systemExtraLarge":
      content = <LargeWidget snapshot={snapshot} logo={logo} mapImage={mapImage} privacy={privacy} />
      break
    default:
      content = <SmallWidget snapshot={snapshot} logo={logo} car={car} />
  }

  Widget.present(content, {
    reloadPolicy: { policy: "after", date: new Date(Date.now() + 30 * 60 * 1000) },
  })
  Script.exit()
}

void main()
