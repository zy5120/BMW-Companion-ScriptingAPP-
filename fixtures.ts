import type { VehicleSnapshot } from "./domain"

export function makeDemoSnapshot(now = new Date()): VehicleSnapshot {
  const observedAt = new Date(now.getTime() - 6 * 60 * 1000)
  return {
    schemaVersion: 1,
    localVehicleId: "demo-bmw-i4",
    identity: {
      displayName: "我的 BMW i4",
      brand: "BMW",
      model: "i4 eDrive40",
      plateMasked: "沪A·•••28",
      plate: "沪A·D1238",
    },
    energy: {
      type: "electric",
      levelPercent: 78,
      rangeKm: 416,
      consumption: 15.8,
      consumptionUnit: "kWh/100km",
    },
    mileageKm: 12846,
    access: {
      lock: "locked",
      doors: "closed",
      windows: "closed",
      roof: "closed",
      hood: "closed",
      trunk: "closed",
      doorStates: {
        leftFront: "closed",
        leftRear: "closed",
        rightFront: "closed",
        rightRear: "closed",
      },
      windowStates: {
        leftFront: "closed",
        leftRear: "closed",
        rightFront: "closed",
        rightRear: "closed",
      },
    },
    tires: {
      frontLeft: { pressureBar: 2.5, targetBar: 2.5, status: "normal" },
      frontRight: { pressureBar: 2.5, targetBar: 2.5, status: "normal" },
      rearLeft: { pressureBar: 2.7, targetBar: 2.7, status: "normal" },
      rearRight: { pressureBar: 2.6, targetBar: 2.7, status: "warning" },
    },
    charging: {
      state: "disconnected",
    },
    location: {
      latitude: 31.2304,
      longitude: 121.4737,
      address: "上海市 · 静安区附近（演示位置）",
      observedAt: observedAt.toISOString(),
    },
    checks: [
      {
        id: "rear-right-tire",
        severity: "warning",
        title: "右后轮胎压略低",
        detail: "当前 2.6 bar，建议值 2.7 bar",
      },
    ],
    vehicleObservedAt: observedAt.toISOString(),
    fetchedAt: now.toISOString(),
    cachedAt: now.toISOString(),
    source: "fixture",
  }
}
