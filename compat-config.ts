export const BMW_CLIENT = {
  version: "5.14.0",
  build: "58417",
  userAgent: "ios(17.6.1);bmw;5.14.0(58417);cn",
  dartUserAgent: "Dart/3.2 (dart:io)",
} as const

export const BMW_HOST = "https://myprofile.bmw.com.cn"
export const COMPAT_NONCE_HOST = "https://m.qqtlr.com"
export const COMPAT_NONCE_PATH = "/bmwNonceV5.php"

export const BMW_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "accept": "application/json",
  "x-user-agent": BMW_CLIENT.userAgent,
  "accept-language": "zh-CN",
  "user-agent": BMW_CLIENT.dartUserAgent,
}

// Reference script values. Temporary compatibility only; never rotate/probe automatically.
export const COMPAT_CORRELATION_ID = "meiDaiSan-only-used-xid"
export const COMPAT_X = "cd16030b4acc1006694040177d4de3fd434a78b4b872397ff77ac7fad6be93d3"

export const COMPAT_HEADERS_X: Record<string, string> = {
  "x-correlation-id": COMPAT_CORRELATION_ID,
  "bmw-correlation-id": COMPAT_CORRELATION_ID,
  x: COMPAT_X,
}
