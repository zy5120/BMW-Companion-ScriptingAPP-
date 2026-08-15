// BMW MINI Linker
// 作者: @厦门硬骨头
// 仅限个人学习使用，请勿用于商业用途。
import {
  Button,
  fetch,
  Gauge,
  HStack,
  Image,
  LazyVGrid,
  Link,
  List,
  Map,
  Marker,
  Navigation,
  NavigationLink,
  NavigationStack,
  ProgressView,
  ScrollView,
  Script,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  Widget,
  useEffect,
  useMemo,
  useObservable,
  useState,
} from "scripting"
import { ConnectionPage } from "./connection-page"
import { fetchFirstVehicleSnapshot, renewSession } from "./bmw-client"
import { BMW_HEADERS, BMW_HOST, brandUserAgent } from "./compat-config"
import { refreshMapSnapshot } from "./map-snapshot"
import { loadSession, saveSession } from "./session-vault"
import type { KnownState, TireState, VehicleSnapshot } from "./domain"
import { CHANGELOG, CURRENT_VERSION, versionNewer, type VersionNote } from "./changelog"
import {
  displayAddress,
  formatRelativeTime,
  formatSyncTime,
  freshnessColor,
  freshnessLabel,
  knownStateLabel,
  lockLabel,
  safetySummary,
} from "./formatters"
import {
  getFreshness,
  loadRuntimeMode,
  loadSettings,
  loadSnapshot,
  refreshDemoSnapshot,
  saveConnectedSnapshot,
  saveSettings,
  setRuntimeMode,
} from "./storage"

const PROJECT_NAME = "BMW MINI Linker"
const ACCENT = "#166DFF"
const CARD = "secondarySystemBackground"

// 首页自动刷新冷却：数据在 5 分钟内的不重复自动刷新（手动点刷新不受限制）
const AUTO_REFRESH_COOLDOWN_MS = 5 * 60_000

// 车况展示按所选车辆品牌切换（BMW / MINI）
function vehicleBrand(snapshot: VehicleSnapshot): string {
  return snapshot.identity.brand?.toLowerCase() === "mini" ? "MINI" : "BMW"
}

// 品牌 logo 图源（车况页车名右侧）
const BMW_LOGO_URL = "https://m.qqtlr.com/logo.png"
const MINI_LOGO_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/MINI_logo.svg/330px-MINI_logo.svg.png"

declare const Dialog: any
declare const Safari: any

function StatusPill({ icon, title, color, spinning = false }: { icon: string; title: string; color: string; spinning?: boolean }) {
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 9, vertical: 5 }}
      background={`${color}18` as any}
      clipShape={{ type: "capsule", style: "continuous" }}
    >
      {spinning ? (
        <SpinningIcon systemName={icon} color={color} />
      ) : (
        <Image systemName={icon} font="caption" foregroundStyle={color as any} />
      )}
      <Text font="caption" fontWeight="semibold" foregroundStyle={color as any}>{title}</Text>
    </HStack>
  )
}

// 持续旋转的图标：配合 Animation.repeatForever 让刷新箭头动态转动
function SpinningIcon({ systemName, color }: { systemName: string; color: string }) {
  const deg = useObservable(0)
  useEffect(() => {
    deg.setValue(360)
  }, [])
  return (
    <Image
      systemName={systemName}
      font="caption"
      foregroundStyle={color as any}
      rotationEffect={deg.value}
      animation={{
        animation: Animation.linear(1).repeatForever(false),
        value: deg.value,
      }}
    />
  )
}

function MetricCard({
  icon,
  title,
  value,
  subtitle,
  tint = ACCENT,
}: {
  icon: string
  title: string
  value: string
  subtitle: string
  tint?: string
}) {
  return (
    <VStack
      alignment="leading"
      spacing={9}
      padding={14}
      frame={{ minHeight: 112, maxWidth: Infinity, alignment: "leading" }}
      background={CARD}
      clipShape={{ type: "rect", cornerRadius: 18, style: "continuous" }}
    >
      <HStack>
        <Image systemName={icon} font="body" foregroundStyle={tint as any} />
        <Spacer />
        <Text font="caption2" foregroundStyle="tertiaryLabel">{title}</Text>
      </HStack>
      <Text font="title2" fontWeight="bold" foregroundStyle="label" lineLimit={1} minScaleFactor={0.7}>
        {value}
      </Text>
      <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={2}>{subtitle}</Text>
    </VStack>
  )
}

function AccessRow({ icon, label, state }: { icon: string; label: string; state: KnownState }) {
  const ok = state === "closed"
  const unknown = state === "unknown"
  const color = unknown ? "#8E8E93" : ok ? "#30D158" : "#FF453A"
  return (
    <HStack spacing={10} padding={{ vertical: 7 }}>
      <Image systemName={icon} font="body" foregroundStyle={color as any} frame={{ width: 24 }} />
      <Text font="body" foregroundStyle="label">{label}</Text>
      <Spacer />
      <Text font="subheadline" fontWeight="medium" foregroundStyle={color as any}>
        {unknown ? "未知" : ok ? "已关闭" : "未关闭"}
      </Text>
    </HStack>
  )
}

function TireCard({ tirePosition, tire }: { tirePosition: string; tire?: TireState }) {
  const warning = tire?.status === "warning"
  const color = !tire || tire.status === "unknown" ? "#8E8E93" : warning ? "#FF9F0A" : "#30D158"
  return (
    <VStack
      alignment="leading"
      spacing={5}
      padding={11}
      frame={{ maxWidth: Infinity, alignment: "leading" }}
      background="tertiarySystemBackground"
      clipShape={{ type: "rect", cornerRadius: 13 }}
    >
      <Text font="caption2" foregroundStyle="secondaryLabel">{tirePosition}</Text>
      <Text font="headline" fontWeight="semibold" foregroundStyle={color as any}>
        {tire?.pressureBar != null ? `${tire.pressureBar.toFixed(1)} bar` : "—"}
      </Text>
      <Text font="caption2" foregroundStyle="tertiaryLabel">
        {warning
          ? (tire?.targetBar != null ? `建议 ${tire.targetBar.toFixed(1)} bar` : "胎压异常，请检查")
          : tire ? "正常" : "状态未知"}
      </Text>
    </VStack>
  )
}

// 官方车辆图片：需要 VIN + 有效 token（Keychain）。用于车况页顶部卡片右侧展示车辆实拍图。
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

function energyTypeLabel(snapshot: VehicleSnapshot): string {
  switch (snapshot.energy.type) {
    case "electric": return "纯电车"
    case "hybrid": return "混动车"
    case "fuel": return "燃油车"
    default: return "车辆能源"
  }
}

function EnergyHero({ snapshot, onChangeEnergyType }: { snapshot: VehicleSnapshot; onChangeEnergyType?: () => void }) {
  const level = snapshot.energy.levelPercent ?? 0
  const range = snapshot.energy.rangeKm
  const electric = snapshot.energy.type === "electric"
  const [carImage, setCarImage] = useState<UIImage | null>(null)
  useEffect(() => {
    let cancelled = false
    setCarImage(null)
    fetchOfficialCarImage(snapshot)
      .then(img => { if (!cancelled && img) setCarImage(img) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [snapshot.vin])
  return (
    <Button action={() => onChangeEnergyType?.()} frame={{ maxWidth: Infinity }}>
      <HStack
        spacing={18}
        padding={18}
        background={{ light: "#EAF2FF", dark: "#10233F" } as any}
        clipShape={{ type: "rect", cornerRadius: 24, style: "continuous" }}
        frame={{ maxWidth: Infinity, alignment: "leading" }}
      >
        <Gauge
          value={level}
          min={0}
          max={100}
          gaugeStyle="accessoryCircularCapacity"
          tint={ACCENT}
          label={<Image systemName={electric ? "bolt.fill" : "fuelpump.fill"} />}
          currentValueLabel={<Text font="headline" fontWeight="bold">{`${Math.round(level)}%`}</Text>}
          frame={{ width: 86, height: 86 }}
        />
        <VStack alignment="leading" spacing={5} layoutPriority={1}>
          <HStack spacing={3}>
            <Text font="caption" fontWeight="semibold" foregroundStyle={ACCENT}>{energyTypeLabel(snapshot)}</Text>
            <Image systemName="chevron.down" font={8} foregroundStyle={ACCENT} />
          </HStack>
          <Text font="caption" foregroundStyle="secondaryLabel">预计剩余续航</Text>
          <Text font={36} fontWeight="bold" foregroundStyle="label" lineLimit={1} minScaleFactor={0.7}>
            {range != null ? `${range} km` : "—"}
          </Text>
          <HStack spacing={5}>
            <Image systemName={electric ? "bolt.car.fill" : "fuelpump.fill"} font="caption" foregroundStyle={ACCENT} />
            <Text font="caption" foregroundStyle="secondaryLabel">
              {snapshot.energy.consumption != null
                ? `${snapshot.energy.consumption}${snapshot.energy.consumptionUnit ? ` ${snapshot.energy.consumptionUnit}` : ""}`
                : "能耗不可用"}
            </Text>
          </HStack>
        </VStack>
        <Spacer />
        {carImage ? (
          <Image image={carImage} resizable scaleToFit frame={{ width: 100, height: 64 }} />
        ) : null}
      </HStack>
    </Button>
  )
}

function VehicleHeader({ snapshot, refreshing = false, refreshResult = null }: {
  snapshot: VehicleSnapshot
  refreshing?: boolean
  refreshResult?: "success" | "failure" | null
}) {
  const freshness = getFreshness(snapshot)
  // 状态胶囊：刷新中显示“正在获取车况”，否则显示最近一次刷新结果（已更新/刷新失败），
  // 没有刷新记录时按数据新鲜度显示（数据最新等）。
  let pillIcon: string
  let pillTitle: string
  let pillColor: string
  let pillSpinning = false
  if (refreshing) {
    pillIcon = "arrow.clockwise"
    pillTitle = "正在获取车况"
    pillColor = "#30D158"
    pillSpinning = true
  } else if (refreshResult === "success") {
    pillIcon = "checkmark.circle.fill"
    pillTitle = "已更新"
    pillColor = "#30D158"
  } else if (refreshResult === "failure") {
    pillIcon = "exclamationmark.triangle.fill"
    pillTitle = "刷新失败"
    pillColor = "#FF453A"
  } else {
    pillIcon = freshness === "fresh" ? "checkmark.circle.fill" : "clock.fill"
    pillTitle = freshnessLabel(freshness)
    pillColor = freshnessColor(freshness)
  }
  const brand = snapshot.identity.brand?.toLowerCase() === "mini" ? "MINI" : "BMW"
  const [brandLogo, setBrandLogo] = useState<UIImage | null>(null)
  useEffect(() => {
    let cancelled = false
    setBrandLogo(null)
    const url = brand === "MINI" ? MINI_LOGO_URL : BMW_LOGO_URL
    UIImage.fromURL(url)
      .then(img => { if (!cancelled && img) setBrandLogo(img) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [brand])
  return (
    <VStack alignment="leading" spacing={14}>
      <HStack alignment="top">
        <VStack alignment="leading" spacing={3}>
          <Text font="largeTitle" fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
            {snapshot.identity.displayName}
          </Text>
          <Text font="subheadline" foregroundStyle="secondaryLabel">
            {[snapshot.identity.model, snapshot.identity.plate ?? snapshot.identity.plateMasked].filter(Boolean).join(" · ")}
          </Text>
        </VStack>
        <Spacer />
        {brandLogo ? (
          <Image image={brandLogo} resizable scaleToFit frame={{ width: 40, height: 40 }} clipShape={{ type: "capsule", style: "continuous" }} />
        ) : (
          <Image
            systemName="car.side.fill"
            font={34}
            foregroundStyle={ACCENT}
            symbolRenderingMode="hierarchical"
          />
        )}
      </HStack>
      <HStack spacing={8}>
        <StatusPill icon={pillIcon} title={pillTitle} color={pillColor} spinning={pillSpinning} />
        <Text font="caption" foregroundStyle="tertiaryLabel">
          {formatRelativeTime(snapshot.fetchedAt)} · {snapshot.source === "network" ? `${vehicleBrand(snapshot)} 数据` : "演示数据"}
        </Text>
      </HStack>
      <Text font="caption" foregroundStyle="tertiaryLabel">
        最近同步 {formatSyncTime(snapshot.vehicleObservedAt) || "未知"}
      </Text>
    </VStack>
  )
}

function StatusDetailsPage({ showClose = false }: { showClose?: boolean }) {
  const dismiss = Navigation.useDismiss()
  const snapshot = loadSnapshot()
  const safety = safetySummary(snapshot)
  return (
    <List
      navigationTitle="车辆状态"
      navigationBarTitleDisplayMode="inline"
      toolbar={showClose ? {
        topBarLeading: [
          <Button
            title="关闭"
            systemImage="xmark.circle.fill"
            action={dismiss}
            fontWeight="semibold"
            foregroundStyle={ACCENT}
            accessibilityLabel="关闭 BMW Companion"
          />,
        ],
      } : undefined}
    >
      <Section
        header={<Text font="headline">安全状态</Text>}
      >
        <HStack spacing={10}>
          <Image
            systemName={safety.safe ? "checkmark.shield.fill" : "exclamationmark.shield.fill"}
            foregroundStyle={(safety.safe ? "#30D158" : "#FF9F0A") as any}
          />
          <Text font="headline">{safety.text}</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">{lockLabel(snapshot.access.lock)}</Text>
        </HStack>
      </Section>
      <Section header={<Text font="headline">门窗状态</Text>}>
        {snapshot.access.doors !== "unknown" ? <AccessRow icon="car.top.door.front.left.open" label="车门" state={snapshot.access.doors} /> : null}
        {snapshot.access.windows !== "unknown" ? <AccessRow icon="car.window.left" label="车窗" state={snapshot.access.windows} /> : null}
        {snapshot.access.roof !== "unknown" ? <AccessRow icon="rectangle.split.3x1" label="天窗" state={snapshot.access.roof} /> : null}
        {snapshot.access.hood !== "unknown" ? <AccessRow icon="car.side.front.open" label="引擎盖" state={snapshot.access.hood} /> : null}
        {snapshot.access.trunk !== "unknown" ? <AccessRow icon="car.side.rear.open" label="后备箱" state={snapshot.access.trunk} /> : null}
        {snapshot.access.doors === "unknown" && snapshot.access.windows === "unknown" && snapshot.access.roof === "unknown" && snapshot.access.hood === "unknown" && snapshot.access.trunk === "unknown" ? (
          <Text font="caption" foregroundStyle="secondaryLabel">该车辆未提供门窗状态数据。</Text>
        ) : null}
      </Section>
    </List>
  )
}

function tireSummaryText(snapshot: VehicleSnapshot): string {
  const tires = snapshot.tires
  // 汇总只看轮胎状态：状态已在数据层跟随官方 checkControlMessages（报低则标低）
  // 并叠加 2.2 bar 敏感阈值，因此无需在此再读官方检查，避免与官方/宝马 APP 矛盾。
  if (!tires) return "暂无胎压数据"
  const all = [tires.frontLeft, tires.frontRight, tires.rearLeft, tires.rearRight]
  if (all.some(tire => tire?.status === "warning")) return "有轮胎气压异常"
  if (all.some(tire => tire?.status === "unknown")) return "部分胎压未知"
  return "四轮胎压正常"
}

function TireDetailsPage() {
  const snapshot = loadSnapshot()
  return (
    <ScrollView navigationTitle="轮胎状态" navigationBarTitleDisplayMode="inline">
      <VStack spacing={16} padding={16}>
        <VStack alignment="leading" spacing={5} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          <Text font="title2" fontWeight="bold">四轮胎压</Text>
          <Text font="subheadline" foregroundStyle="secondaryLabel">{snapshot.source === "network" ? "数据来自车辆最近一次同步。" : "当前为演示数据。"}</Text>
        </VStack>
        <LazyVGrid
          columns={[
            { size: { type: "flexible" }, spacing: 10 },
            { size: { type: "flexible" }, spacing: 10 },
          ]}
          spacing={10}
        >
          {snapshot.tires ? (
            <>
              <TireCard tirePosition="左前" tire={snapshot.tires.frontLeft} />
              <TireCard tirePosition="右前" tire={snapshot.tires.frontRight} />
              <TireCard tirePosition="左后" tire={snapshot.tires.rearLeft} />
              <TireCard tirePosition="右后" tire={snapshot.tires.rearRight} />
            </>
          ) : (
            <VStack
              alignment="center"
              spacing={6}
              padding={24}
              frame={{ maxWidth: Infinity, alignment: "center" }}
              background={CARD}
              clipShape={{ type: "rect", cornerRadius: 16 }}
            >
              <Image systemName="tirepressure" font={30} foregroundStyle="secondaryLabel" />
              <Text font="subheadline" foregroundStyle="secondaryLabel">该车辆未提供胎压数据。</Text>
            </VStack>
          )}
        </LazyVGrid>
      </VStack>
    </ScrollView>
  )
}

function LocationPage({ showClose = false }: { showClose?: boolean }) {
  const dismiss = Navigation.useDismiss()
  const snapshot = loadSnapshot()
  const settings = loadSettings()
  const location = snapshot.location
  const privacy = settings.privacyMode

  const updateWidgetMap = async () => {
    if (!location) return
    const ok = await refreshMapSnapshot(location.latitude, location.longitude)
    void Dialog?.alert?.({
      title: ok ? "已更新" : "更新失败",
      message: ok ? "停车位置地图已更新，桌面大号组件将显示。" : "地图生成失败，请稍后重试。",
      buttonLabel: "好",
    })
  }

  if (!location) {
    return (
      <VStack navigationTitle="停车位置" spacing={12} padding={24}>
        <Image systemName="location.slash.fill" font={42} foregroundStyle="secondaryLabel" />
        <Text font="headline">位置不可用</Text>
      </VStack>
    )
  }
  const mapURL = `https://maps.apple.com/?ll=${location.latitude},${location.longitude}&q=${encodeURIComponent(snapshot.identity.displayName)}`
  return (
    <ScrollView
      navigationTitle="停车位置"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarLeading: showClose ? [
          <Button
            title="关闭"
            systemImage="xmark.circle.fill"
            action={dismiss}
            fontWeight="semibold"
            foregroundStyle={ACCENT}
            accessibilityLabel="关闭 BMW Companion"
          />,
        ] : undefined,
        topBarTrailing: [
          <Button
            title="更新组件地图"
            systemImage="arrow.triangle.2.circlepath"
            action={() => void updateWidgetMap()}
            fontWeight="semibold"
            foregroundStyle={ACCENT}
          />,
        ],
      }}
    >
      <VStack spacing={14} padding={16}>
        {privacy ? (
          <VStack
            spacing={10}
            frame={{ maxWidth: Infinity, height: 270 }}
            background={CARD}
            clipShape={{ type: "rect", cornerRadius: 20 }}
          >
            <Image systemName="eye.slash.fill" font={38} foregroundStyle="secondaryLabel" />
            <Text font="headline">隐私模式已隐藏地图</Text>
          </VStack>
        ) : (
          <Map
            initialCameraPosition={MapCameraPosition.region({
              center: { latitude: location.latitude, longitude: location.longitude },
              span: { latitudeDelta: 0.002, longitudeDelta: 0.002 },
            })}
            mapStyle={{ style: "standard", showsTraffic: true }}
            frame={{ maxWidth: Infinity, height: 270 }}
            clipShape={{ type: "rect", cornerRadius: 20 }}
          >
            <Marker
              title={snapshot.identity.displayName}
              coordinate={{ latitude: location.latitude, longitude: location.longitude }}
              systemImage="car.fill"
              tint={ACCENT}
            />
          </Map>
        )}
        <VStack
          alignment="leading"
          spacing={8}
          padding={16}
          frame={{ maxWidth: Infinity, alignment: "leading" }}
          background={CARD}
          clipShape={{ type: "rect", cornerRadius: 18 }}
        >
          <Text font="headline">{displayAddress(snapshot, privacy)}</Text>
          <Text font="caption" foregroundStyle="secondaryLabel">
            {`车辆上报于 ${formatRelativeTime(location.observedAt)}`}
          </Text>
          {!privacy ? (
            <Button title="在 Apple 地图中打开" systemImage="map.fill" action={() => Safari?.openURL?.(mapURL)} />
          ) : null}
        </VStack>
      </VStack>
    </ScrollView>
  )
}

function WidgetPreviewPage() {
  const options = {
    "默认总览": JSON.stringify({ vehicleId: "demo-bmw-i4", theme: "overview" }),
  }
  const preview = async (family: "accessoryRectangular" | "systemSmall" | "systemMedium" | "systemLarge") => {
    await Widget.preview({ family, parameters: { options, default: "默认总览" } })
  }
  return (
    <List navigationTitle="Widget 预览" navigationBarTitleDisplayMode="inline">
      <Section
        header={<Text font="headline">组件尺寸</Text>}
        footer={<Text font="caption">预览使用本地演示快照。桌面最终效果仍需真机验收。</Text>}
      >
        <Button title="锁屏矩形" systemImage="rectangle.inset.filled" action={() => void preview("accessoryRectangular")} />
        <Button title="小号" systemImage="square" action={() => void preview("systemSmall")} />
        <Button title="中号" systemImage="rectangle" action={() => void preview("systemMedium")} />
        <Button title="大号" systemImage="square.fill" action={() => void preview("systemLarge")} />
      </Section>
    </List>
  )
}

function SettingsPage() {
  const settings0 = loadSettings()
  const [noTiresLine1, setNoTiresLine1] = useState(settings0.noTiresLine1 ?? "")
  const [noTiresLine2, setNoTiresLine2] = useState(settings0.noTiresLine2 ?? "")
  const persistNoTiresLine1 = (value: string) => {
    setNoTiresLine1(value)
    saveSettings({ ...loadSettings(), noTiresLine1: value })
    Widget.reloadAll()
  }
  const persistNoTiresLine2 = (value: string) => {
    setNoTiresLine2(value)
    saveSettings({ ...loadSettings(), noTiresLine2: value })
    Widget.reloadAll()
  }
  const [alwaysDark, setAlwaysDark] = useState(settings0.alwaysDarkBackground ?? false)
  const persistAlwaysDark = (value: boolean) => {
    setAlwaysDark(value)
    saveSettings({ ...loadSettings(), alwaysDarkBackground: value })
    Widget.reloadAll()
  }
  const connectionDestination = useMemo(() => <ConnectionPage />, [])
  // 点击「关于 → 版本」弹出更新日志
  const [showChangelog, setShowChangelog] = useState(false)
  return (
    <List
      navigationTitle="设置"
      navigationBarTitleDisplayMode="inline"
      sheet={{
        isPresented: showChangelog,
        onChanged: setShowChangelog,
        content: <UpdateSheet notes={CHANGELOG} />,
      }}
    >
      <Section
        header={<Text font="headline">BMW 账号</Text>}
      >
        <NavigationLink destination={connectionDestination}>
          <HStack>
            <Image systemName="car.badge.key.fill" foregroundStyle={ACCENT} />
            <Text>连接与会话管理</Text>
            <Spacer />
            <Text font="caption" foregroundStyle="secondaryLabel">{loadSession() ? "已连接" : "未连接"}</Text>
          </HStack>
        </NavigationLink>
      </Section>
      <Section
        header={<Text font="headline">无胎压数据时显示</Text>}
        footer={<Text font="caption">部分车辆（如无胎压传感器的车型）不会返回四轮胎压数据，组件会空出两行。在此填入自定义文案，分别显示在组件胎压区域的两行占位处；留空则不显示占位。</Text>}
      >
        <TextField title="第一行" prompt="如：暂无胎压数据" value={noTiresLine1} onChanged={persistNoTiresLine1} />
        <TextField title="第二行" prompt="如：请检查车辆配置" value={noTiresLine2} onChanged={persistNoTiresLine2} />
      </Section>
      <Section
        header={<Text font="headline">组件外观</Text>}
        footer={<Text font="caption">开启后，即使手机处于浅色模式，桌面组件也始终显示深色背景（文字颜色会同步调整，保证可读）。</Text>}
      >
        <Toggle title="浅色模式下也显示深色背景" value={alwaysDark} onChanged={persistAlwaysDark} />
      </Section>
      <Section
        header={<Text font="headline">关于</Text>}
        footer={
          <VStack alignment="leading" spacing={3}>
            <Text font="caption" foregroundStyle="secondaryLabel">点击版本号可查看更新日志</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">本插件完全免费，如果遇到任何售卖请及时投诉。</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">本工具仅供个人学习使用</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">请勿用于商业用途</Text>
          </VStack>
        }
      >
        <HStack>
          <Text>版本</Text>
          <Spacer />
          <Button
            title={CURRENT_VERSION}
            action={() => setShowChangelog(true)}
            foregroundStyle="secondaryLabel"
          />
        </HStack>
        <HStack>
          <Text>作者</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">@厦门硬骨头</Text>
        </HStack>
        <Link url="https://qun.qq.com/universal-share/share?ac=1&authKey=CKOUbxyi8UYm3oz8sboNeezGyBAkKpYn5ihduL3MqPz%2F8jdz9iEIji02uv5fcsgP&busi_data=eyJncm91cENvZGUiOiI4MTI0MzMyOSIsInRva2VuIjoiNjlmWWZlTGJ6UnR3NHZReUNPZExjSUp2WXZPWkpaeWZEVEdTR1FsS3dLQVkxbk92bU1MVFdFYmFHU2c2TkczbiIsInVpbiI6IjQ5MzIxNDg3MiJ9&data=9bDeOii4T7L0nrjay-6OAnsSeus0sY63xcxLurytdiwqa3oDhSi5zR6v5vkqYUVEqFfQ9c4RZVhT8IfGwZbzNA&svctype=4&tempid=h5_group_info">
          <HStack>
            <Text>点我进群</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">QQ群：81243329</Text>
            <Image systemName="arrow.up.right" font={12} foregroundStyle="secondaryLabel" />
          </HStack>
        </Link>
      </Section>
    </List>
  )
}

function LocationMapCard({ snapshot }: { snapshot: VehicleSnapshot }) {
  const center = {
    latitude: snapshot.location!.latitude,
    longitude: snapshot.location!.longitude,
  }
  const camera = useObservable<MapCameraPosition>(
    MapCameraPosition.region({
      center,
      span: { latitudeDelta: 0.002, longitudeDelta: 0.002 },
    }),
  )
  const bounds = MapCameraBounds.centerCoordinateBounds(
    { center, span: { latitudeDelta: 0.001, longitudeDelta: 0.001 } },
    { minimumDistance: 200, maximumDistance: 250 },
  )
  return (
    <VStack alignment="leading" spacing={8}>
      <Text font="title3" fontWeight="bold">车辆位置</Text>
      <Map
        cameraPosition={camera}
        cameraBounds={bounds}
        allowsHitTesting={false}
        mapStyle={{ style: "standard", showsTraffic: false }}
        frame={{ maxWidth: Infinity, height: 220 }}
        clipShape={{ type: "rect", cornerRadius: 20 }}
      >
        <Marker
          title={snapshot.identity.displayName}
          coordinate={center}
          systemImage="car.fill"
          tint={ACCENT}
        />
      </Map>
      <Text font="caption" foregroundStyle="secondaryLabel">
        {displayAddress(snapshot, false)} · 最近同步 {formatSyncTime(snapshot.vehicleObservedAt)}
      </Text>
    </VStack>
  )
}

function DashboardPage() {
  const dismiss = Navigation.useDismiss()
  const [snapshot, setSnapshot] = useState(() => loadSnapshot())
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<"success" | "failure" | null>(null)
  const freshness = getFreshness(snapshot)
  const safety = safetySummary(snapshot)
  const brand = vehicleBrand(snapshot)
  const detailsDestination = useMemo(() => <StatusDetailsPage />, [])
  const tireDestination = useMemo(() => <TireDetailsPage />, [])
  const previewDestination = useMemo(() => <WidgetPreviewPage />, [])
  const settingsDestination = useMemo(() => <SettingsPage />, [])

  // 从设置/连接页返回时（登录成功或切换车辆后），自动重载最新快照
  const reloadFromStorage = () => {
    const next = loadSnapshot()
    setSnapshot(next)
  }

  // 兑底：手动切换车辆能源类型（燃油/混动/纯电），仅当前车辆生效
  const changeEnergyType = async () => {
    const index = await Dialog.actionSheet({
      title: "车辆能源类型",
      message: "自动识别失败或不准时，可手动指定（仅当前车辆生效）。",
      actions: ["自动识别", "燃油车", "混动车", "纯电车"].map(label => ({ label })),
    })
    if (index == null) return
    const key = snapshot.vin ?? snapshot.localVehicleId
    const settings = loadSettings()
    const overrides = { ...(settings.energyTypeOverrides ?? {}) }
    if (index === 0) {
      delete overrides[key]
    } else {
      overrides[key] = (["fuel", "hybrid", "electric"] as const)[index - 1]
    }
    saveSettings({ ...settings, energyTypeOverrides: overrides })
    setSnapshot(loadSnapshot())
    Widget.reloadAll()
  }

  const refresh = async () => {
    if (refreshing) return
    const session = loadSession()
    if (!session) {
      const next = refreshDemoSnapshot()
      setSnapshot(next)
      setRefreshResult("success")
      Widget.reloadAll()
      return
    }
    setRefreshing(true)
    try {
      let usable = session
      if (Date.parse(session.accessTokenExpiresAt) <= Date.now() + 60_000) {
        usable = await renewSession(session)
        saveSession(usable)
      }
      const next = await fetchFirstVehicleSnapshot(usable, loadSettings().selectedVin || undefined)
      saveConnectedSnapshot(next)
      setRuntimeMode("connected")
      setSnapshot(next)
      setRefreshResult("success")
      Widget.reloadAll()
      // 自动生成停车位置地图快照（离屏渲染），供桌面大号组件使用
      if (next.location) {
        void refreshMapSnapshot(next.location.latitude, next.location.longitude)
      }
    } catch {
      setRefreshResult("failure")
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <ScrollView
      navigationTitle="车况"
      navigationBarTitleDisplayMode="large"
      onAppear={() => {
        reloadFromStorage()
        // 每次打开首页自动刷新车况（5 分钟内数据较新则跳过，避免频繁请求）
        const snapshot = loadSnapshot()
        const cachedAt = Date.parse(snapshot.cachedAt)
        if (!Number.isFinite(cachedAt) || Date.now() - cachedAt >= AUTO_REFRESH_COOLDOWN_MS) {
          void refresh()
        }
      }}
      toolbar={{
        topBarLeading: [
          <Button
            title="关闭"
            systemImage="xmark.circle.fill"
            action={dismiss}
            fontWeight="semibold"
            foregroundStyle={ACCENT}
            accessibilityLabel="关闭 BMW Companion"
          />,
        ],
        topBarTrailing: [
          <Button
            title={refreshing ? "正在刷新" : loadSession() ? `刷新 ${brand} 车况` : "刷新演示数据"}
            systemImage="arrow.clockwise"
            disabled={refreshing}
            action={() => void refresh()}
          />,
          <NavigationLink destination={settingsDestination}>
            <Image systemName="gearshape.fill" foregroundStyle={ACCENT} />
          </NavigationLink>,
        ],
      }}
    >
      <VStack alignment="leading" spacing={16} padding={{ horizontal: 16, top: 10, bottom: 28 }}>
        <VehicleHeader snapshot={snapshot} refreshing={refreshing} refreshResult={refreshResult} />
        <EnergyHero snapshot={snapshot} onChangeEnergyType={changeEnergyType} />

        <LazyVGrid
          columns={[
            { size: { type: "flexible" }, spacing: 10 },
            { size: { type: "flexible" }, spacing: 10 },
          ]}
          spacing={10}
        >
          <MetricCard
            icon={snapshot.access.lock === "locked" ? "lock.shield.fill" : "lock.open.fill"}
            title="车辆安全"
            value={lockLabel(snapshot.access.lock)}
            subtitle={safety.text}
            tint={safety.safe ? "#30D158" : "#FF9F0A"}
          />
          <MetricCard
            icon="gauge.with.dots.needle.67percent"
            title="总里程"
            value={snapshot.mileageKm != null ? `${snapshot.mileageKm.toLocaleString()} km` : "—"}
            subtitle={snapshot.source === "network" ? `${brand} 车辆数据` : "本地演示数据"}
          />
        </LazyVGrid>

        <VStack alignment="leading" spacing={10}>
          <HStack>
            <Text font="title3" fontWeight="bold">需要关注</Text>
            <Spacer />
            <StatusPill
              icon={snapshot.checks.length ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"}
              title={snapshot.checks.length ? `${snapshot.checks.length} 项` : "全部正常"}
              color={snapshot.checks.length ? "#FF9F0A" : "#30D158"}
            />
          </HStack>
          {snapshot.checks.length ? snapshot.checks.map(check => {
            const critical = check.severity === "critical"
            const icon = critical ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill"
            const color = critical ? "#FF453A" : "#FF9F0A"
            return (
              <HStack
                key={check.id}
                spacing={12}
                padding={14}
                frame={{ maxWidth: Infinity, alignment: "leading" }}
                background={CARD}
                clipShape={{ type: "rect", cornerRadius: 17 }}
              >
                <Image systemName={icon} foregroundStyle={color as any} font="title3" />
                <VStack alignment="leading" spacing={3} layoutPriority={1}>
                  <Text font="headline" lineLimit={2}>{check.title}</Text>
                  {check.detail && check.detail !== check.title ? (
                    <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={3}>{check.detail}</Text>
                  ) : null}
                </VStack>
              </HStack>
            )
          }) : (
            <Text foregroundStyle="secondaryLabel">暂无需要关注的项目</Text>
          )}
        </VStack>

        {snapshot.location && !loadSettings().privacyMode ? (
          <LocationMapCard snapshot={snapshot} />
        ) : null}

        <VStack alignment="leading" spacing={10}>
          <Text font="title3" fontWeight="bold">快速查看</Text>
          <NavigationLink destination={detailsDestination}>
            <HStack
              spacing={12}
              padding={14}
              background={CARD}
              clipShape={{ type: "rect", cornerRadius: 17 }}
            >
              <Image systemName="lock.shield.fill" foregroundStyle="#30D158" font="title3" />
              <VStack alignment="leading" spacing={2}>
                <Text font="headline">门窗与锁车</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {knownStateLabel(snapshot.access.doors, "车门")}
                </Text>
              </VStack>
              <Spacer />
              <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" />
            </HStack>
          </NavigationLink>
          <NavigationLink destination={tireDestination}>
            <HStack spacing={12} padding={14} background={CARD} clipShape={{ type: "rect", cornerRadius: 17 }}>
              <Image systemName="circle.circle.fill" foregroundStyle="#FF9F0A" font="title3" />
              <VStack alignment="leading" spacing={2}>
                <Text font="headline">四轮胎压</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">{tireSummaryText(snapshot)}</Text>
              </VStack>
              <Spacer />
              <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" />
            </HStack>
          </NavigationLink>
          <NavigationLink destination={previewDestination}>
            <HStack spacing={12} padding={14} background={CARD} clipShape={{ type: "rect", cornerRadius: 17 }}>
              <Image systemName="square.grid.2x2.fill" foregroundStyle="#AF52DE" font="title3" />
              <VStack alignment="leading" spacing={2}>
                <Text font="headline">Widget 预览</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">锁屏、小号、中号和大号</Text>
              </VStack>
              <Spacer />
              <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" />
            </HStack>
          </NavigationLink>
        </VStack>
      </VStack>
    </ScrollView>
  )
}

// 更新展示 sheet：版本更新后首次进入插件时弹出，下滑即可关闭
function UpdateSheet({ notes }: { notes: VersionNote[] }) {
  return (
    <VStack
      spacing={0}
      alignment="leading"
      padding={20}
      frame={{ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }}
      presentationDetents={["medium", "large"]}
      presentationDragIndicator="visible"
    >
      <Text font="title2" fontWeight="bold">更新内容</Text>
      <ScrollView>
        <VStack alignment="leading" spacing={16} padding={{ top: 14, bottom: 20 }}>
          {notes.map(note => (
            <VStack key={note.version} alignment="leading" spacing={6}>
              <Text font="headline">v{note.version} · {note.title}</Text>
              {note.notes.map((line, index) => (
                <HStack key={index} spacing={8} alignment="firstTextBaseline">
                  <Text font="caption" foregroundStyle={ACCENT}>•</Text>
                  <Text font="subheadline" foregroundStyle="secondaryLabel">{line}</Text>
                </HStack>
              ))}
            </VStack>
          ))}
        </VStack>
      </ScrollView>
    </VStack>
  )
}

function RootView() {
  const route = String(Script.queryParameters.route ?? "overview")
  const initial = route === "location"
    ? <LocationPage showClose />
    : route === "status"
      ? <StatusDetailsPage showClose />
      : <DashboardPage />
  const [showUpdate, setShowUpdate] = useState(false)
  const lastSeen = loadSettings().lastSeenVersion ?? ""
  useEffect(() => {
    if (!lastSeen || versionNewer(CURRENT_VERSION, lastSeen)) setShowUpdate(true)
  }, [])
  // 弹层展示完整更新日志（触发时机仍只看是否有新版本）
  const updateNotes = CHANGELOG
  const closeUpdate = (visible: boolean) => {
    setShowUpdate(visible)
    if (!visible) {
      saveSettings({ ...loadSettings(), lastSeenVersion: CURRENT_VERSION })
    }
  }
  return (
    <NavigationStack
      sheet={{
        isPresented: showUpdate,
        onChanged: closeUpdate,
        content: <UpdateSheet notes={updateNotes} />,
      }}
    >
      {initial}
    </NavigationStack>
  )
}

async function main() {
  try {
    loadSnapshot()
    await Navigation.present({ element: <RootView />, modalPresentationStyle: "overFullScreen" })
  } catch (error: any) {
    const message = error?.message ? String(error.message) : String(error)
    try {
      await Dialog?.alert?.({ title: "BMW Companion 无法打开", message, buttonLabel: "关闭" })
    } catch {}
  } finally {
    Script.exit()
  }
}

void main()
