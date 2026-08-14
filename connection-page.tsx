import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  Picker,
  ProgressView,
  SecureField,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  Widget,
  useEffect,
  useState,
} from "scripting"
import {
  fetchFirstVehicleSnapshot,
  fetchVehicleList,
  loginWithPassword,
  loginWithSms,
  requestSmsCode,
  type SmsChallenge,
  type VehicleListItem,
} from "./bmw-client"
import {
  grantNonceConsent,
  loadNonceConsent,
  nonceDisclosure,
  revokeNonceConsent,
} from "./nonce-provider"
import { loadSession, removeSession, saveSession } from "./session-vault"
import { refreshMapSnapshot } from "./map-snapshot"
import { loadSettings, saveConnectedSnapshot, saveSettings, setRuntimeMode } from "./storage"

const ACCENT = "#166DFF"

// 运行时只提供全局 Dialog 对象（prototype 上有 alert/confirm/prompt/actionSheet），
// 并不存在全局 confirm 函数（类型声明有但运行时为 undefined）。
declare const Dialog: {
  confirm(options: {
    title?: string
    message: string
    cancelLabel?: string
    confirmLabel?: string
  }): Promise<boolean>
}

type Operation = "idle" | "sendingSms" | "passwordLogin" | "smsLogin" | "switching"

function errorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  const known: Record<string, string> = {
    NONCE_CONSENT_REQUIRED: "请先阅读并同意服务说明。",
    MOBILE_INVALID: "请输入正确的中国大陆手机号（86 + 11 位，或 11 位手机号）。",
    PASSWORD_INVALID: "请输入 BMW 密码。",
    CAPTCHA_POSITION_NOT_FOUND: "未能识别滑动验证码，请稍后重试。",
    CAPTCHA_VERIFY_REJECTED: "图形校验未通过，请稍后重试。",
    PUBLIC_KEY_INVALID: "BMW 安全连接异常，请稍后重试。",
    PASSWORD_ENCRYPTION_FAILED: "密码处理失败，请重试。",
    LOGIN_REJECTED: "BMW 拒绝登录，请检查账号、密码或验证码。",
    SMS_REQUEST_REJECTED: "短信验证码发送失败。",
    SMS_CODE_INVALID: "请输入收到的短信验证码。",
    NONCE_PROVIDER_REJECTED: "辅助服务暂时不可用，请稍后重试。",
    NONCE_RESPONSE_INVALID: "辅助服务返回异常，请稍后重试。",
    VEHICLE_LIST_EMPTY: "账号下没有读取到车辆。",
    VEHICLE_STATE_INVALID: "车辆状态获取失败，请稍后重试。",
  }
  if (known[code]) return known[code]
  if (code.startsWith("BMW_HTTP_")) return `BMW 请求失败（${code.replace("BMW_HTTP_", "HTTP ")}）。`
  if (code.startsWith("NONCE_HTTP_")) return `辅助服务请求失败（${code.replace("NONCE_HTTP_", "HTTP ")}）。`
  return `操作失败：${code.slice(0, 120)}`
}

export function ConnectionPage() {
  const dismiss = Navigation.useDismiss()
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [smsCode, setSmsCode] = useState("")
  const [challenge, setChallenge] = useState<SmsChallenge | null>(null)
  const [consented, setConsented] = useState(() => Boolean(loadNonceConsent()))
  const [operation, setOperation] = useState<Operation>("idle")
  const [status, setStatus] = useState(loadSession() ? "已保存 BMW 会话" : "尚未连接")
  const busy = operation !== "idle"

  const [vehicles, setVehicles] = useState<VehicleListItem[]>([])
  const [selectedVin, setSelectedVin] = useState("")
  const [vehicleLoading, setVehicleLoading] = useState(false)

  const reloadVehicles = async () => {
    const session = loadSession()
    if (!session) return
    try {
      const list = await fetchVehicleList(session)
      setVehicles(list)
      const saved = loadSettings().selectedVin
      if (saved && list.some(item => item.vin.toUpperCase() === saved.toUpperCase())) {
        setSelectedVin(saved)
      } else if (list[0]) {
        setSelectedVin(list[0].vin)
      }
    } catch (error) {
      console.warn("vehicle list failed:", errorMessage(error))
    } finally {
      setVehicleLoading(false)
    }
  }

  useEffect(() => {
    if (loadSession()) setVehicleLoading(true)
    void reloadVehicles()
  }, [])

  const switchVehicle = async (vin: string) => {
    if (busy || !vin) return
    const session = loadSession()
    if (!session) {
      setStatus("请先登录后再切换车辆")
      return
    }
    const previous = selectedVin
    setSelectedVin(vin)
    setOperation("switching")
    setStatus("正在切换车辆…")
    try {
      const snapshot = await fetchFirstVehicleSnapshot(session, vin)
      saveSettings({ ...loadSettings(), selectedVin: vin })
      saveConnectedSnapshot(snapshot)
      setRuntimeMode("connected")
      Widget.reloadAll()
      setStatus(`已切换至 ${snapshot.identity.displayName}`)
    } catch (error) {
      setSelectedVin(previous)
      setStatus(errorMessage(error))
    } finally {
      setOperation("idle")
    }
  }

  const askConsent = async () => {
    const accepted = await Dialog.confirm({
      title: "服务说明",
      message: `${nonceDisclosure.message}\n\n仅在你点击登录、发送短信或刷新时调用。是否同意？`,
      cancelLabel: "不同意",
      confirmLabel: "同意并继续",
    })
    if (accepted) {
      grantNonceConsent()
      setConsented(true)
      setStatus("已同意服务说明")
    }
  }

  const finishLogin = async (session: Awaited<ReturnType<typeof loginWithPassword>>) => {
    // Verify read-only vehicle access before committing the new session.
    const snapshot = await fetchFirstVehicleSnapshot(session)
    saveSession(session)
    saveConnectedSnapshot(snapshot)
    setRuntimeMode("connected")
    Widget.reloadAll()
    setStatus(`连接成功：${snapshot.identity.displayName}`)
    void reloadVehicles()
    // 登录成功后自动生成停车位置地图快照，供桌面大号组件使用
    if (snapshot.location) {
      void refreshMapSnapshot(snapshot.location.latitude, snapshot.location.longitude)
    }
  }

  const passwordLogin = async () => {
    if (busy) return
    setOperation("passwordLogin")
    setStatus("正在进行密码登录…")
    try {
      const session = await loginWithPassword(phone, password)
      await finishLogin(session)
      setPassword("")
    } catch (error) {
      setStatus(errorMessage(error))
    } finally {
      setPassword("")
      setOperation("idle")
    }
  }

  const sendSms = async () => {
    if (busy) return
    setOperation("sendingSms")
    setStatus("正在完成图形校验并发送短信…")
    try {
      const next = await requestSmsCode(phone)
      setChallenge(next)
      setStatus("短信已发送，请输入验证码")
    } catch (error) {
      setStatus(errorMessage(error))
    } finally {
      setOperation("idle")
    }
  }

  const smsLogin = async () => {
    if (busy || !challenge) return
    setOperation("smsLogin")
    setStatus("正在使用短信验证码登录…")
    try {
      const session = await loginWithSms(challenge, smsCode)
      await finishLogin(session)
      setSmsCode("")
      setChallenge(null)
    } catch (error) {
      setStatus(errorMessage(error))
    } finally {
      setSmsCode("")
      setOperation("idle")
    }
  }

  const signOut = async () => {
    const accepted = await Dialog.confirm({
      title: "退出 BMW 会话？",
      message: "将清除本机的登录信息，已同步的车况数据会保留。",
      cancelLabel: "取消",
      confirmLabel: "退出登录",
    })
    if (!accepted) return
    try {
      removeSession()
      setRuntimeMode("demo")
      Widget.reloadAll()
      setStatus("已退出，当前使用演示模式")
    } catch (error) {
      setStatus(errorMessage(error))
    }
  }

  return (
    <List
      navigationTitle="连接 BMW"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarTrailing: [
          <Button title="完成" action={dismiss} foregroundStyle={ACCENT} fontWeight="semibold" />,
        ],
      }}
    >
      <Section
        header={<Text font="headline">连接状态</Text>}
        footer={<Text font="caption">密码和短信验证码不会保存；登录凭证只安全保存在本机。</Text>}
      >
        <HStack spacing={10}>
          {busy ? <ProgressView /> : <Image systemName={loadSession() ? "checkmark.shield.fill" : "car.badge.key.fill"} foregroundStyle={ACCENT} />}
          <Text>{status}</Text>
        </HStack>
        {loadSession() ? (
          vehicleLoading ? (
            <HStack spacing={8}>
              <ProgressView />
              <Text font="caption" foregroundStyle="secondaryLabel">正在加载车辆列表…</Text>
            </HStack>
          ) : vehicles.length > 0 ? (
            <Picker
              value={selectedVin}
              onChanged={(value: string) => void switchVehicle(value)}
              pickerStyle="menu"
              title="切换车辆"
              systemImage="car.2.fill"
            >
              {vehicles.map(item => (
                <Text key={item.vin} tag={item.vin}>
                  {item.brand} {item.model}{item.licensePlate ? ` · ${item.licensePlate}` : ""}
                </Text>
              ))}
            </Picker>
          ) : (
            <Text font="caption" foregroundStyle="secondaryLabel">未加载到车辆列表，请先登录。</Text>
          )
        ) : null}
      </Section>

      <Section
        header={<Text font="headline">登录辅助服务</Text>}
        footer={<Text font="caption">登录依赖第三方辅助服务（非 BMW 官方）。拒绝后仍可体验演示数据。</Text>}
      >
        <VStack alignment="leading" spacing={8} padding={{ vertical: 6 }}>
          <Text font="subheadline" fontWeight="semibold">m.qqtlr.com</Text>
          <Text font="caption" foregroundStyle="secondaryLabel">登录时会发送手机号等必要信息到该服务，可能留下访问记录；密码、短信验证码和登录凭证不会发送。</Text>
        </VStack>
        {consented ? (
          <Button
            title="撤回授权"
            systemImage="hand.raised.fill"
            role="destructive"
            action={() => {
              revokeNonceConsent()
              setConsented(false)
              setStatus("已撤回授权")
            }}
          />
        ) : (
          <Button title="阅读并同意" systemImage="checkmark.shield" action={askConsent} />
        )}
      </Section>

      <Section
        header={<Text font="headline">BMW 账号</Text>}
        footer={<Text font="caption">手机号需含国家区号：86 + 11 位（如 8613800138000）。手机号仅在提交时使用，不会保存。</Text>}
      >
        <TextField title="手机号" prompt="86 开头，如 8613800138000" value={phone} onChanged={setPhone} />
      </Section>

      <Section
        header={<Text font="headline">短信登录</Text>}
        footer={<Text font="caption">图形校验和短信挑战不会保存；页面关闭后需重新发送。若短信通道不可用，可改用下方密码登录。</Text>}
      >
        <Button
          title={operation === "sendingSms" ? "正在发送" : "发送短信验证码"}
          systemImage="message.fill"
          disabled={!consented || busy || !phone}
          action={sendSms}
        />
        {challenge ? (
          <>
            <TextField title="短信验证码" prompt="输入验证码" value={smsCode} onChanged={value => setSmsCode(value.replace(/\D/g, "").slice(0, 8))} />
            <Button
              title={operation === "smsLogin" ? "正在登录" : "使用短信验证码连接"}
              systemImage="checkmark.circle.fill"
              disabled={busy || !smsCode}
              action={smsLogin}
            />
          </>
        ) : null}
      </Section>

      <Section header={<Text font="headline">密码登录</Text>}>
        <SecureField title="BMW 密码" prompt="输入密码" value={password} onChanged={setPassword} />
        <Button
          title={operation === "passwordLogin" ? "正在登录" : "使用密码连接"}
          systemImage="key.fill"
          disabled={!consented || busy || !phone || !password}
          action={passwordLogin}
        />
      </Section>

      <Section header={<Text font="headline">会话管理</Text>}>
        <Button title="退出 BMW 会话" systemImage="rectangle.portrait.and.arrow.right" role="destructive" action={signOut} />
      </Section>
    </List>
  )
}
