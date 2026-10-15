import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'

/** The platform crypto service over workerd's WebCrypto primitives; also used by local Node fixtures. */
export const CryptoLive = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(data))),
        catch: (cause) => PlatformError.systemError({ _tag: 'Unknown', module: 'Crypto', method: 'digest', cause }),
      }),
  }),
)
