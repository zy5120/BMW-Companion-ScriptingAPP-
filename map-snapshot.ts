import { Widget } from "scripting"

// 桌面大号组件使用的地图快照路径（App Group 共享目录，组件可读）
export function mapSnapshotPath(): string {
  return `${FileManager.appGroupDocumentsDirectory}/car-location-map.png`
}

// 用 MapKit 离屏渲染一张 Apple 原生地图（带车辆标注），保存为 PNG。
// 刷新车况后自动调用，无需任何界面操作；大号组件读取该图片显示。
// 尺寸取大（1280×720），组件内按填充+裁剪显示，高分辨率设备上也不会显小。
export async function refreshMapSnapshot(
  latitude: number,
  longitude: number,
  size = { width: 1280, height: 720 },
): Promise<boolean> {
  try {
    const snap = await MapSnapshotter.take({
      region: {
        center: { latitude, longitude },
        span: { latitudeDelta: 0.002, longitudeDelta: 0.002 },
      },
      size,
      mapStyle: { style: "standard", showsTraffic: false },
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
