import { Image, HStack, VStack, ZStack, ImageRenderer, Script, Widget } from "scripting"
import { loadSettings, scriptKeyNamespace } from "./storage"

// 桌面大号组件使用的地图快照路径（App Group 共享目录，组件可读）；
// 文件名带脚本命名空间，多脚本各自使用自己的地图文件。
export function mapSnapshotPath(): string {
  return `${FileManager.appGroupDocumentsDirectory}/car-location-map-${scriptKeyNamespace()}.png`
}

// WGS84 经纬度 → Web 墨卡托瓦片坐标（连续值）
function lonToX(lon: number, z: number): number {
  return (lon + 180) / 360 * Math.pow(2, z)
}
function latToY(lat: number, z: number): number {
  const rad = lat * Math.PI / 180
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z)
}

// 免费用户：把 Carto 瓦片拼成地图（亮/暗随系统），叠加蓝色车标，用 ImageRenderer 渲染成一张图。
// 仅在 App(index) 环境执行 —— 组件扩展无 UI 上下文，ImageRenderer 无法渲染。
async function renderOpenSourceMap(
  latitude: number,
  longitude: number,
  width: number,
  height: number,
  dark: boolean,
): Promise<UIImage | null> {
  const z = 16
  const tile = (x: number, y: number) => dark
    ? `https://a.basemaps.cartocdn.com/rastertiles/dark_all/${z}/${x}/${y}.png`
    : `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`
  const fx = lonToX(longitude, z)
  const fy = latToY(latitude, z)
  const x0 = Math.floor(fx) - 2
  const y0 = Math.floor(fy) - 1
  const cols = 4
  const rows = 3
  // 失败瓦片用灰色占位图，保证网格完整（全部成功时用真实瓦片）
  const blank = await ImageRenderer.toUIImage(
    <ZStack frame={{ width: 256, height: 256 }} background={{ light: "#E5E5E5", dark: "#2C2C2E" } as any} />,
    { scale: 1 },
  )
  const tiles: UIImage[] = []
  for (let dy = 0; dy < rows; dy++) {
    for (let dx = 0; dx < cols; dx++) {
      tiles.push((await UIImage.fromURL(tile(x0 + dx, y0 + dy))) ?? blank)
    }
  }
  const cell = (img: UIImage, key: number) => (
    <Image key={key} image={img} resizable scaleToFill frame={{ width: 256, height: 256 }} />
  )
  const grid = await ImageRenderer.toUIImage(
    <VStack spacing={0}>
      {[0, 1, 2].map(r => (
        <HStack key={r} spacing={0}>
          {[0, 1, 2, 3].map(c => cell(tiles[r * cols + c], r * cols + c))}
        </HStack>
      ))}
    </VStack>,
    { scale: 1 },
  )
  // 车辆在网格中的像素位置；裁切 width×height 让车辆居中
  const px = (fx - x0) * 256
  const py = (fy - y0) * 256
  const cropX = Math.max(0, Math.min(grid.width - width, px - width / 2))
  const cropY = Math.max(0, Math.min(grid.height - height, py - height / 2))
  const cropped = grid.croppedTo({ x: cropX, y: cropY, width, height })
  if (!cropped) return null
  // 叠加居中蓝色车标（与 Pro 版 MapSnapshotter 的 car.fill 标注一致）
  return await ImageRenderer.toUIImage(
    <ZStack frame={{ width, height }}>
      <Image image={cropped} resizable scaleToFill frame={{ width, height }} />
      <Image systemName="car.fill" font={24} foregroundStyle="#166DFF" />
    </ZStack>,
    { scale: 1 },
  )
}

// 刷新车况后自动生成大号组件底部的地图（保存 PNG）。
// Pro 用户用 Apple MapKit 离屏快照（更精细，支持深浅色）；免费用户用 Carto 开源底图拼图 + 车标。
// 尺寸与地理范围保持 620×440 + 0.0008 正方形（组件显示宽高不变）。
export async function refreshMapSnapshot(
  latitude: number,
  longitude: number,
  size = { width: 620, height: 440 },
): Promise<boolean> {
  const dark = loadSettings().alwaysDarkBackground === true || Device.colorScheme === "dark"
  // 免费用户：不调用 PRO 的 MapSnapshotter，改走开源底图拼图，避免「解锁 Scripting PRO」弹窗
  if (!Script.hasFullAccess()) {
    try {
      if (Script.env !== "index") return false // 组件/其他扩展无 UI 上下文
      const img = await renderOpenSourceMap(latitude, longitude, size.width, size.height, dark)
      if (!img) return false
      const png = img.toPNGData()
      if (!png) return false
      FileManager.writeAsDataSync(mapSnapshotPath(), png)
      Widget.reloadAll()
      return true
    } catch (error) {
      console.warn("open-source map fallback failed:", error instanceof Error ? error.message : String(error))
      return false
    }
  }
  // Pro 用户：原生 Apple MapKit 离屏快照
  try {
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
