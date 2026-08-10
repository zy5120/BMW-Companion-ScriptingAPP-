import { AppIntentManager, AppIntentProtocol, Widget } from "scripting"
import { loadSettings, recordWidgetReload, saveSettings } from "./storage"

export const RefreshDemoIntent = AppIntentManager.register<void>({
  name: "BMWCompanionRefreshDemoIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    // Phase 0 intentionally performs no network request and no vehicle command.
    // It only records explicit user intent and asks WidgetKit to rebuild from shared fixture data.
    recordWidgetReload()
    Widget.reloadAll()
  },
})

export const SetPrivacyIntent = AppIntentManager.register<boolean>({
  name: "BMWCompanionSetPrivacyIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (enabled: boolean) => {
    saveSettings({ ...loadSettings(), privacyMode: enabled })
    Widget.reloadAll()
  },
})
