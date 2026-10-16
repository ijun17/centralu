/** The loose shape the adapter reads SDK messages in, and the string reader it uses on them. */
export type Json = Record<string, unknown>
export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
