import { BMW_CLIENT } from "./compat-config"

/**
 * Clean-room rewrite of the bounded arithmetic at the end of the reference
 * script's getSignature(). No anti-debugging, self-modifying code, eval,
 * recursion, mutable loop bounds or growing arrays are present here.
 *
 * This signature protects the request to the temporary nonce provider. It is
 * NOT BMW's x-login-nonce algorithm.
 */
export function createCompatProviderSignature(
  identifier: string,
  nowMilliseconds = Date.now(),
  build = BMW_CLIENT.build,
): string {
  const numericIdentifier = identifier.replace(/\D/g, "").slice(0, 13)
  if (!/^\d{1,13}$/.test(numericIdentifier)) {
    throw new Error("COMPAT_SIGNATURE_INVALID_IDENTIFIER")
  }
  if (!/^\d{1,8}$/.test(build)) {
    throw new Error("COMPAT_SIGNATURE_INVALID_BUILD")
  }
  if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
    throw new Error("COMPAT_SIGNATURE_INVALID_TIME")
  }

  const identifierNumber = Number(numericIdentifier)
  const buildNumber = Number(build)
  // The reference base class returns Unix seconds, and getSignature divides that
  // value by 1000 once more. Preserve that unusual contract exactly.
  const referenceTimeBucket = Math.floor(nowMilliseconds / 1_000_000)
  const mixed = identifierNumber + referenceTimeBucket + buildNumber
  if (!Number.isSafeInteger(mixed) || mixed <= 0) {
    throw new Error("COMPAT_SIGNATURE_UNSAFE_INTEGER")
  }

  const reversedBase36 = mixed.toString(36).split("").reverse().join("")
  const decimalCodePoints = Array.from(reversedBase36)
    .map(character => character.codePointAt(0)?.toString(10) ?? "")
    .join("")
  const substitution = Array.from(decimalCodePoints)
    .map((digit, index) => Math.abs(Number(digit) - index).toString(10))
    .join("")

  if (substitution.length < 10) {
    throw new Error("COMPAT_SIGNATURE_SUBSTITUTION_TOO_SHORT")
  }

  const permuted = Array.from(numericIdentifier)
    .map(digit => substitution[Number(digit)])
    .join("")
  if (!/^\d+$/.test(permuted)) {
    throw new Error("COMPAT_SIGNATURE_PERMUTATION_FAILED")
  }

  const result = Number(permuted).toString(36)
  if (!/^[0-9a-z]+$/.test(result) || result.length > 32) {
    throw new Error("COMPAT_SIGNATURE_OUTPUT_INVALID")
  }
  return result
}
