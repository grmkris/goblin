import { notNowList } from './not-now.ts'

/** The Telegram offers this browser was told "Not now" (ADR 0055), by chat key; the chat keeps waiting in the Chats list. */
const telegram = notNowList('goblin:telegram-not-now')

/** The chat keys told "Not now". */
export const notNowChats = telegram.read

/**
 * Remembers "Not now" for `key`, keeping only the keys still `offered` (a chat routed since needs no entry), and gives
 * the keys now remembered.
 */
export const rememberNotNow = telegram.remember
