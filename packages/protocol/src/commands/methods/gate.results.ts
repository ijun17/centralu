import { z } from 'zod'

/** The result of the `gate` method. Its parameters, and what it is for: ./gate.params.ts */
export const gateResults = {
  'gate.ask': z.discriminatedUnion('decision', [z.object({ decision: z.literal('allow') }), z.object({ decision: z.literal('deny'), reason: z.string() })]),
} as const
