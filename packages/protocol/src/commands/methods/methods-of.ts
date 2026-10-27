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
  const joined: Record<string, { params: z.ZodType; result: z.ZodType }> = {}
  for (const [k, p] of Object.entries(params)) joined[k] = { params: p, result: results[k as keyof R] }
  // The loop above pairs each key of `params` with the same key of `results`, which is what `Joined` says
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return joined as Joined<P, R>
}
