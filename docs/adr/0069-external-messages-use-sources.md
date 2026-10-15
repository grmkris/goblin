# 0069: External messages use Sources

Accepted 2026-10-15. Completes the replacement in ADR 0066 and supersedes ADRs 0009 and 0055 in full. Mygram, directly
or through MySI, carries messages through the same owner-confirmed Source setup as every other MCP server. Keeping a
second built-in transport would duplicate cursor, route, reply and authority rules and preserve server-specific
exceptions that ADR 0063 removes.

The built-in Telegram runtime, owner API, contracts, extension tools, UI switch, route offers and dedicated fixtures
are removed. The owner confirms exact Source selectors, pointers and templates; explicit own-turn metadata identifies
their turns in the web. Events keep generic transport health, and no service flag hides an event from the picker.
Notifications leave through Notify me via, with the result and exact echo rules in ADR 0071.

This is a greenfield removal: disposable dev is reset, then its owner reconnects and confirms fresh Sources. It does
not decode or migrate legacy channel state. Production remains frozen until the owner lifts its release freeze.
Local tests establish code behavior only. Live MySI authorization and Mygram DM/group/photo replies are deferred to
the separate acceptance session in the development guide; removing the old channel does not count as those receipts.
