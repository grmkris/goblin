# Deferred Home dashboard

## Deferred Home dashboard

Main contains the transcript and composer, without a dashboard above the input. It opens at the transcript's end and uses the same jump button as other conversations. Apps follow page > inline placement; saved Home tiles no longer displace their tool-row views. The browser has no Home pinning, edit mode, tile renderer or special receipt actions.

The runtime Home service, its tools, contracts and application tables remain active, and the workspace feed carries the layout (`home`); the owner API has no Home endpoint. Layout revisions, operation replay, owner authority and app-deletion cleanup still apply. Saved layouts and app state remain intact for a later UI iteration (ADR 0025). Layout edits currently have no visible browser surface; the agent's guidance says so and does not offer Home placement.
