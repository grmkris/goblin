// Keys for one purpose each, derived from the deployment's `CREDENTIAL_KEY`: an HMAC made for one purpose (a webhook's
// route, a file link) never verifies for another, and none of them is the credential key itself.
import { constantTimeEqual } from 'better-auth/crypto'

const encoder = new TextEncoder()

/** The HMAC-SHA-256 key for `purpose`: HKDF-SHA-256 over `credentialKey` (base64), no salt, `purpose` as its info. */
async function purposeKey(credentialKey: string, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(credentialKey), (c) => c.codePointAt(0) ?? 0),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode(purpose) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

/** `bytes` as unpadded base64url, the form a token takes in a URL path. */
export const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')

/** The bytes unpadded base64url `text` holds (it must be base64url). */
export const bytesOfBase64url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.codePointAt(0) ?? 0)

/** The HMAC of `message` under `purpose`'s key, as unpadded base64url (43 characters). */
export async function purposeMac(credentialKey: string, purpose: string, message: string): Promise<string> {
  const key = await purposeKey(credentialKey, purpose)
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))))
}

/** Whether `mac` is the HMAC of `message` under `purpose`'s key, compared in constant time. */
export async function purposeMacMatches(
  credentialKey: string,
  purpose: string,
  message: string,
  mac: string,
): Promise<boolean> {
  const expected = await purposeMac(credentialKey, purpose, message)
  return constantTimeEqual(encoder.encode(expected), encoder.encode(mac))
}
