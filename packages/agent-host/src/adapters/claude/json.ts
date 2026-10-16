/** The loose shape the adapter reads SDK messages in, and the string reader it uses on them (one meaning, json-value.ts, #850) */
export type Json = Record<string, unknown>
export { str } from '../../json-value.js'
