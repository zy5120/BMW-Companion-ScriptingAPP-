import { Intent, Script } from "scripting"
import { displayAddress, freshnessLabel, lockLabel, safetySummary } from "./formatters"
import { getFreshness, loadSettings, loadWidgetSnapshot } from "./storage"

const snapshot = loadWidgetSnapshot()
const settings = loadSettings()
const safety = safetySummary(snapshot)
const requested = Intent.shortcutParameter?.value
const wantsJSON = typeof requested === "string" && requested.toLowerCase().includes("json")

if (wantsJSON) {
  Script.exit(Intent.json({
    schemaVersion: 1,
    vehicle: snapshot.identity.displayName,
    vehicleId: snapshot.localVehicleId,
    energyPercent: snapshot.energy.levelPercent ?? null,
    rangeKm: snapshot.energy.rangeKm ?? null,
    mileageKm: snapshot.mileageKm ?? null,
    lock: snapshot.access.lock,
    safety: safety.text,
    alerts: snapshot.checks.map(check => ({
      severity: check.severity,
      title: check.title,
    })),
    location: settings.privacyMode ? null : displayAddress(snapshot, false),
    freshness: getFreshness(snapshot),
    source: snapshot.source,
  }))
} else {
  const alertText = snapshot.checks.length
    ? `需要关注：${snapshot.checks.map(check => check.title).join("、")}。`
    : "没有需要关注的项目。"
  const energyPart =
    snapshot.energy.type === "electric"
      ? `${snapshot.energy.levelPercent ?? "未知"}% 电量`
      : snapshot.energy.type === "hybrid"
        ? `${snapshot.energy.levelPercent ?? "未知"}% 电量${snapshot.energy.remainingLiters != null ? `、${Math.round(snapshot.energy.remainingLiters)}L 油量` : ""}`
        : snapshot.energy.remainingLiters != null
          ? `${Math.round(snapshot.energy.remainingLiters)}L 油量`
          : "能源信息未知"
  Script.exit(Intent.text(
    `${snapshot.identity.displayName}，${energyPart}，` +
    `${snapshot.energy.rangeKm ?? "未知"} 公里预计续航，${lockLabel(snapshot.access.lock)}，` +
    `${safety.text}。${alertText}${freshnessLabel(getFreshness(snapshot))}。`,
  ))
}
