import { Widget } from "scripting"
import { loadSettings, scriptKeyNamespace } from "./storage"

// 桌面大号组件使用的地图快照路径（App Group 共享目录，组件可读）；
// 文件名带脚本命名空间，多脚本各自使用自己的地图文件。
export function mapSnapshotPath(): string {
  return `${FileManager.appGroupDocumentsDirectory}/car-location-map-${scriptKeyNamespace()}.png`
}

// 用 MapKit 离屏渲染一张 Apple 原生地图（带车辆标注），保存为 PNG。
// 刷新车况后自动调用，无需任何界面操作；大号组件读取该图片显示。
// 尺寸与地理范围保持原始 620×440 + 0.0008 正方形（组件显示宽高不变），仅追加深浅色适配。
export async function refreshMapSnapshot(
  latitude: number,
  longitude: number,
  size = { width: 620, height: 440 },
): Promise<boolean> {
  try {
    // 地图外观跟随深浅色：系统深色模式或开启「浅色模式也显示深色背景」时用深色地图
    const dark = loadSettings().alwaysDarkBackground === true || Device.colorScheme === "dark"
    const snap = await MapSnapshotter.take({
      region: {
        center: { latitude, longitude },
        span: { latitudeDelta: 0.0008, longitudeDelta: 0.0008 },
      },
      size,
      mapStyle: { style: "standard", showsTraffic: false },
      appearance: dark ? "dark" : "light",
      annotations: [
        {
          coordinate: { latitude, longitude },
          tintColor: "#166DFF",
          glyph: "car.fill",
          title: "车辆位置",
        },
      ],
    })
    const png = snap.image.toPNGData()
    if (!png) return false
    FileManager.writeAsDataSync(mapSnapshotPath(), png)
    Widget.reloadAll()
    return true
  } catch (error) {
    console.warn("map snapshot failed:", error instanceof Error ? error.message : String(error))
    return false
  }
}
