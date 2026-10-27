# ADR 0126: Preserve approved powers when keys retire

Status: Accepted 2026-10-27. Amends ADR 0125's migration and stored receipt behavior.

## Context

ADR 0125 removed the `keys` extra from the contract. Existing OAuth grants, app terms and turn receipts can still
contain it. Their strict decoders then reject the entire extras list or power, losing unrelated approved powers.
Auth migration `0007_no_keys.sql` has already run on dev, so changing it would leave that deployment uncorrected.

## Decision

Add auth migration `0008_no_key_extras.sql`. Remove only `keys` from surviving grants and registered app terms.
Preserve every other field, including expiry, revocation, exact reach, origins and installations. Invalid JSON stays
invalid and fails closed. The migration is safe to reapply.

Add application migration `NO_KEY_POWERS`. Remove only `keys` from stored turn powers and rename historical receipt
origin `key` to `app`. Keep the recorded level, server attribution and scope lists. A receipt with no readable power
still uses the existing read-only fallback. This does not create an installation or grant authority to an old key.
Historical maker IDs and names remain historical attribution; only newly created resources name an app client.

These are forward data migrations. Existing deployed migrations and vendor-owned tables remain unchanged; no reset
is needed. Production removal still follows ADR 0125's requirement to move consumers to installed apps first.

## Validation

Seeded SQLite tests check retained grants, terms, reach, installations, expiry and revocation, malformed data,
idempotence, and receipt decoding after migration.
