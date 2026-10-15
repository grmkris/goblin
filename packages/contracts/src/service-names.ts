// The names of an app's tools and Events, as the server goblin reaches it through spells them (ADR 0052). An app's own
// server names them bare (mygram's `inbox_read` and `message.received`); mysi, which serves every my* app behind one
// connection, prefixes each with the app's service id: `<service>_<tool>` and `<service>.<event>` (`mygram_inbox_read`,
// `mygram.message.received`). Every check of such a name, in the runtime and the web, goes through here.

/** The names `tool` of `service` goes by: the app's own, then mysi's. */
export const toolSpellings = (service: string, tool: string): readonly [string, string] => [tool, `${service}_${tool}`]
