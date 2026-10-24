/**
 * An OAuth client's secret as the auth store keeps it (ADR 0118): its SHA-256, base64url without padding. That is Better
 * Auth's own default ("hashed"), configured explicitly (`options.ts` `storeClientSecret`) so goblin's rotation of an
 * app's secret writes exactly what the token endpoint checks, and secrets stored before keep verifying.
 */
export const clientSecretHash = async (secret: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  return btoa(String.fromCodePoint(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** Letters a new client secret is drawn from, as Better Auth draws its own. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** A new client secret: 48 letters from the platform's random source. */
export const newClientSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(48))
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length] ?? 'a').join('')
}
