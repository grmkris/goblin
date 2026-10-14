# Isolated memory experiments

## Isolated memory experiments

The [benchmark workspace](../../bench/README.md) replays private, redacted Claude and Hermes histories through native Pi write
submissions in its own local workerd actors. OptChat, native compaction and lexical archive search share fixed source
cutoffs and bounded API/retrieval allowances. Source tool calls are transcript evidence; the benchmark installs only
recall/search tools and never executes historical commands. Expected claims stay on the coordinator host, outside
worker requests. Private manifests, source hashes, API ledgers, native contexts and identity-bound semantic reviews
make runs inspectable. Recall v2 compares the four memory/search combinations with a coupled DeepSeek writer and
reader, enforces phase and cutoff allowances, and requires a durable operational receipt before the later cutoff.
Blinded packets preserve unmodified answers; separate machine/human votes and adjudication provide semantic scores
alongside strict format/evidence results. Shared construction is charged once per memory. This local recall
experiment does not mutate a deployed user's agent or prove coding continuation.

The overnight coordinator binds multiple frozen corpora and monotonically extended memory artifacts to one durable
budget covering native preflight, construction, answers, independent machine review and retries. Native replay uses
bounded closed tool exchanges; search pairs reuse checkpoints, while probe forks isolate generated answers. Build
receipts distinguish cold, extended and reused work. Blinded Muse findings remain diagnostic until independent human
review; real source checkpoints and explicit product criteria do not authorize production promotion.
