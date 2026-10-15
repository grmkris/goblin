// Where a Telegram route's "New topic" goes (ADR 0055): a Topic named after the chat or forum topic
// (`topicFor`, sources/places.ts), made once per chat and topic by a deterministic operation.

/** The deterministic operation of the Topic a chat's or topic's "New topic" makes. */
export const topicOperation = (chat: string, thread: number) => `telegram:${chat}:${String(thread)}`
