import type { z } from 'zod'

type Joined<P extends Record<string, z.ZodType>, R extends Record<keyof P, z.ZodType>> = {
  readonly [K in keyof P]: { readonly params: P[K]; readonly result: R[K] }
}

/**
 * A method group from its two halves: the parameters (the host validates them) and the results (a client reads them).
 * They live in modules of their own so the UI's bundle carries the results only; this joins them for whoever needs
 * both. The two have to name the same methods, or this does not compile.
 */
export function methodsOf<P extends Record<string, z.ZodType>, R extends Record<keyof P, z.ZodType>>(
  params: P,
  results: R & { readonly [K in keyof R]: K extends keyof P ? z.ZodType : never },
): Joined<P, R> {
  const resultOf = new Map<string, z.ZodType>(Object.entries(results))
  const joined: Record<string, { params: z.ZodType; result: z.ZodType }> = {}
  for (const [k, p] of Object.entries(params)) {
    const result = resultOf.get(k)
    if (!result) throw new Error(`methodsOf: no result schema for ${k}`)
    joined[k] = { params: p, result }
  }
  if (!pairsEvery<P, R>(joined, params)) throw new Error('methodsOf: the halves name different methods')
  return joined
}

/** Whether `joined` pairs every key of `params`, which is what `Joined` says of it. */
function pairsEvery<P extends Record<string, z.ZodType>, R extends Record<keyof P, z.ZodType>>(
  joined: Record<string, unknown>,
  params: P,
): joined is Joined<P, R> {
  return Object.keys(params).every((k) => k in joined)
}
