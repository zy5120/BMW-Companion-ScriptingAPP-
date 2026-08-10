// BMW Companion
// 作者: @厦门硬骨头
// 部分逻辑参考 Scriptable BMW 小组件作者: @没打伞
// 仅限个人学习使用，请尊重原作者代码，勿直接抄袭
import {
  Button,
  Gauge,
  HStack,
  Image,
  LazyVGrid,
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
  Toggle,
  VStack,
  Widget,
  useMemo,
  useObservable,
  useState,
} from "scripting"
import { ConnectionPage } from "./connection-page"
import { fetchFirstVehicleSnapshot, renewSession } from "./bmw-client"
import { loadSession, saveSession } from "./session-vault"
import type { KnownState, TireState, VehicleSnapshot } from "./domain"
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
  resetDemoSnapshot,
  saveConnectedSnapshot,
  saveSettings,
  setRuntimeMode,
} from "./storage"

const PROJECT_NAME = "BMW Companion"
const ACCENT = "#166DFF"
const CARD = "secondarySystemBackground"

declare const Dialog: any
declare const Safari: any

function StatusPill({ icon, title, color }: { icon: string; title: string; color: string }) {
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 9, vertical: 5 }}
      background={`${color}18` as any}
      clipShape={{ type: "capsule", style: "continuous" }}
    >
      <Image systemName={icon} font="caption" foregroundStyle={color as any} />
      <Text font="caption" fontWeight="semibold" foregroundStyle={color as any}>{title}</Text>
    </HStack>
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
        {warning ? `建议 ${tire?.targetBar?.toFixed(1) ?? "—"}` : tire ? "正常" : "状态未知"}
      </Text>
    </VStack>
  )
}

function EnergyHero({ snapshot }: { snapshot: VehicleSnapshot }) {
  const level = snapshot.energy.levelPercent ?? 0
  const range = snapshot.energy.rangeKm
  const electric = snapshot.energy.type === "electric"
  return (
    <HStack
      spacing={18}
      padding={18}
      background={{ light: "#EAF2FF", dark: "#10233F" } as any}
      clipShape={{ type: "rect", cornerRadius: 24, style: "continuous" }}
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
    </HStack>
  )
}

function VehicleHeader({ snapshot }: { snapshot: VehicleSnapshot }) {
  const freshness = getFreshness(snapshot)
  return (
    <VStack alignment="leading" spacing={14}>
      <HStack alignment="top">
        <VStack alignment="leading" spacing={3}>
          <Text font="largeTitle" fontWeight="bold" lineLimit={1} minScaleFactor={0.7}>
            {snapshot.identity.displayName}
          </Text>
          <Text font="subheadline" foregroundStyle="secondaryLabel">
            {[snapshot.identity.model, snapshot.identity.plateMasked].filter(Boolean).join(" · ")}
          </Text>
        </VStack>
        <Spacer />
        <Image
          systemName="car.side.fill"
          font={34}
          foregroundStyle={ACCENT}
          symbolRenderingMode="hierarchical"
        />
      </HStack>
      <HStack spacing={8}>
        <StatusPill
          icon={freshness === "fresh" ? "checkmark.circle.fill" : "clock.fill"}
          title={freshnessLabel(freshness)}
          color={freshnessColor(freshness)}
        />
        <Text font="caption" foregroundStyle="tertiaryLabel">
          {formatRelativeTime(snapshot.fetchedAt)} · {snapshot.source === "network" ? "BMW 数据" : "演示数据"}
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
        footer={<Text font="caption">未知状态不会被视为安全。Phase 0 不执行任何车辆控制。</Text>}
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
        <AccessRow icon="car.side.front.open" label="车门" state={snapshot.access.doors} />
        <AccessRow icon="rectangle.split.3x1" label="车窗" state={snapshot.access.windows} />
        <AccessRow icon="sunroof.fill" label="天窗" state={snapshot.access.roof} />
        <AccessRow icon="car.side.front.open" label="引擎盖" state={snapshot.access.hood} />
        <AccessRow icon="car.side.rear.open" label="后备箱" state={snapshot.access.trunk} />
      </Section>
    </List>
  )
}

function tireSummaryText(snapshot: VehicleSnapshot): string {
  const tires = snapshot.tires
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
          <Text font="subheadline" foregroundStyle="secondaryLabel">{snapshot.source === "network" ? "数值来自最近一次 BMW 连接快照。" : "数值来自本地演示快照，仅用于布局验证。"}</Text>
        </VStack>
        <LazyVGrid
          columns={[
            { size: { type: "flexible" }, spacing: 10 },
            { size: { type: "flexible" }, spacing: 10 },
          ]}
          spacing={10}
        >
          <TireCard tirePosition="左前" tire={snapshot.tires?.frontLeft} />
          <TireCard tirePosition="右前" tire={snapshot.tires?.frontRight} />
          <TireCard tirePosition="左后" tire={snapshot.tires?.rearLeft} />
          <TireCard tirePosition="右后" tire={snapshot.tires?.rearRight} />
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
              span: { latitudeDelta: 0.025, longitudeDelta: 0.025 },
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
    "默认总览": JSON.stringify({ vehicleId: "demo-bmw-i4", theme: "overview", privacy: "inherit" }),
    "隐私模式": JSON.stringify({ vehicleId: "demo-bmw-i4", theme: "overview", privacy: "on" }),
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
  const initial = loadSettings()
  const [privacyMode, setPrivacyMode] = useState(initial.privacyMode)
  const persistPrivacy = (value: boolean) => {
    setPrivacyMode(value)
    saveSettings({ ...loadSettings(), privacyMode: value })
    Widget.reloadAll()
  }
  const connectionDestination = useMemo(() => <ConnectionPage />, [])
  return (
    <List navigationTitle="设置" navigationBarTitleDisplayMode="inline">
      <Section
        header={<Text font="headline">BMW 账号</Text>}
        footer={<Text font="caption">临时兼容版只允许前台登录和刷新。第三方 nonce 服务会在连接页单独披露并征得同意。</Text>}
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
        header={<Text font="headline">隐私</Text>}
        footer={<Text font="caption">开启后隐藏停车地址和地图。Token 与账号不会写入快照；VIN 仅用于在组件中获取官方车辆图片。</Text>}
      >
        <Toggle title="隐私模式" value={privacyMode} onChanged={persistPrivacy} />
      </Section>
      <Section
        header={<Text font="headline">本地数据</Text>}
        footer={<Text font="caption">演示快照与最后一次有效 BMW 快照分开保存；网络失败不会覆盖旧数据。</Text>}
      >
        <Button
          title="重置演示快照"
          systemImage="arrow.counterclockwise"
          action={() => {
            resetDemoSnapshot()
            Widget.reloadAll()
            void Dialog?.alert?.({ title: "已重置", message: "演示数据已恢复。", buttonLabel: "好" })
          }}
        />
      </Section>
      <Section
        header={<Text font="headline">关于</Text>}
        footer={<Text font="caption">部分逻辑参考 Scriptable BMW 小组件 @没打伞。本工具仅供个人学习使用，请勿用于商业用途。</Text>}
      >
        <HStack>
          <Text>版本</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">0.1.0</Text>
        </HStack>
        <HStack>
          <Text>作者</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">@厦门硬骨头</Text>
        </HStack>
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
  const [refreshStatus, setRefreshStatus] = useState("")
  const freshness = getFreshness(snapshot)
  const safety = safetySummary(snapshot)
  const detailsDestination = useMemo(() => <StatusDetailsPage />, [])
  const tireDestination = useMemo(() => <TireDetailsPage />, [])
  const previewDestination = useMemo(() => <WidgetPreviewPage />, [])
  const settingsDestination = useMemo(() => <SettingsPage />, [])

  const refresh = async () => {
    if (refreshing) return
    const session = loadSession()
    if (!session) {
      const next = refreshDemoSnapshot()
      setSnapshot(next)
      setRefreshStatus("未连接 BMW，已刷新演示快照")
      Widget.reloadAll()
      return
    }
    setRefreshing(true)
    setRefreshStatus("正在读取 BMW 车况…")
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
      setRefreshStatus("BMW 车况已更新")
      Widget.reloadAll()
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      setRefreshStatus(`刷新失败，继续显示上次数据：${code.slice(0, 100)}`)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <ScrollView
      navigationTitle="车况"
      navigationBarTitleDisplayMode="large"
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
            title={refreshing ? "正在刷新" : loadSession() ? "刷新 BMW 车况" : "刷新演示数据"}
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
        <VehicleHeader snapshot={snapshot} />
        <EnergyHero snapshot={snapshot} />

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
            subtitle={snapshot.source === "network" ? "BMW 只读快照" : "本地演示快照"}
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

        <HStack spacing={7}>
          <Image systemName="shield.lefthalf.filled" foregroundStyle={freshnessColor(freshness) as any} />
          <Text font="caption" foregroundStyle="secondaryLabel">
            {`${freshnessLabel(freshness)} · ${snapshot.source === "network" ? "BMW 只读数据" : "演示模式"}`}
          </Text>
        </HStack>
        {refreshStatus ? (
          <Text font="caption" foregroundStyle="secondaryLabel">{refreshStatus}</Text>
        ) : null}
      </VStack>
    </ScrollView>
  )
}

function RootView() {
  const route = String(Script.queryParameters.route ?? "overview")
  const initial = route === "location"
    ? <LocationPage showClose />
    : route === "status"
      ? <StatusDetailsPage showClose />
      : <DashboardPage />
  return <NavigationStack>{initial}</NavigationStack>
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
