type Joined<P, R extends Record<keyof P, unknown>> = {
  readonly [K in keyof P]: { readonly params: P[K]; readonly result: R[K] }
}

/**
 * Joins a group's params (host-parsed) and results (client-read), kept apart so the UI's bundle carries only the
 * results. Both must name the same methods, or this does not compile.
 *
 * Not bounded by `z.ZodType`: that bound cost `tsc --noEmit` 830k more symbols and 870k more instantiations (#1671; a
 * release rehearsal ran out of heap on macOS). The modules building the halves hold only zod schemas.
 */
export function methodsOf<P extends Record<string, unknown>, R extends Record<keyof P, unknown>>(
  params: P,
  results: R & { readonly [K in keyof R]: K extends keyof P ? unknown : never },
): Joined<P, R> {
  const resultOf = new Map<string, unknown>(Object.entries(results))
  const joined: Record<string, { params: unknown; result: unknown }> = {}
  for (const [k, p] of Object.entries(params)) {
    const result = resultOf.get(k)
    if (!result) throw new Error(`methodsOf: no result schema for ${k}`)
    joined[k] = { params: p, result }
  }
  if (!pairsEvery<P, R>(joined, params)) throw new Error('methodsOf: the halves name different methods')
  return joined
}

/** Whether `joined` pairs every key of `params`, which is what `Joined` says of it. */
function pairsEvery<P extends Record<string, unknown>, R extends Record<keyof P, unknown>>(
  joined: Record<string, unknown>,
  params: P,
): joined is Joined<P, R> {
  return Object.keys(params).every((k) => k in joined)
}
