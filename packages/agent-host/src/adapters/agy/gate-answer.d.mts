/** The types of `gate-answer.mjs`, the plain module the gate hook `agy-gate.mjs` runs */

export type GateAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string }

type GateIo = {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function gateAnswer(io: GateIo & { input: string }): Promise<GateAnswer>

export function runHook(io: GateIo & { stdin: AsyncIterable<Uint8Array | string>; write: (line: string) => void }): Promise<void>

export const ARGUMENT_BOUND: number

export function cutLongArguments(input: string): Promise<string>
