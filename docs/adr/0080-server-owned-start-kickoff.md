# ADR 0080: Server-owned Start kickoff

Status: Accepted. Amends ADR 0079's kickoff orchestration and retry contract.

Start previously coordinated channel creation, kickoff recording, message submission and completion in the browser.
A failure between those calls made the browser responsible for durable progress. `POST /api/onboarding/kickoff`
now owns the sequence in the runtime, using the existing Topic creation operation and chat operation receipt rather
than a second progress store. The browser keeps only the frozen goal, channel name and operation id.

The channel and message operations derive from the kickoff id. The reminder is recorded before submitting the goal,
so the first model request sees it. A retry with a submitted or settled message receipt skips submission and finishes
Start; it does not run new-message admission again after the channel or budget has changed. An admitted or refused
receipt retries the same Pi submission. This uses the existing receipt retention window, not an indefinite guarantee
of external completion or exactly-once effects.

Only typed `Conflict:topic_name_taken` or `InvalidInput:empty_message|topic_name` prove that no channel was created
and let the browser edit the draft under a new operation. Admission failures and unknown responses can follow
creation, so they retain the same draft and operation for retry. The sequence is resumable, not one transaction
across Pi submission.

The kickoff's time and channel are one optional value. `OnboardingStore` is their sole writer and derives both
columns from that value in one insert/upsert; the reader accepts only a complete pair. Keep the existing baseline:
a second check in SQL would add protection against out-of-band writes without changing application behavior, while
requiring a destructive dev reset. This change needs no schema migration or reset.
