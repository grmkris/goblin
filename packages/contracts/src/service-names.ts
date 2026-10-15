// The names of an app's tools and Events, as the server goblin reaches it through spells them (ADR 0052).
// A server names tools and events bare; a gateway that serves several apps behind one connection prefixes each with
// the app's service id: `<service>_<tool>` and `<service>.<event>`. Every check of such a name goes through here.

/** The names `tool` of `service` goes by: the app's own, then a gateway's. */
export const toolSpellings = (service: string, tool: string): readonly [string, string] => [tool, `${service}_${tool}`]
