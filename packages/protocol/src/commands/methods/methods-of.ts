type Joined<P, R extends Record<keyof P, unknown>> = {
  readonly [K in keyof P]: { readonly params: P[K]; readonly result: R[K] }
}

/**
 * A method group from its two halves: the parameters (the host validates them) and the results (a client reads them).
 * They live in modules of their own so the UI's bundle carries the results only; this joins them for whoever needs
 * both. The two have to name the same methods, or this does not compile.
 *
 * The halves are not bounded by `z.ZodType`: checking each of some hundred schemas against it, in every group, made
 * `tsc --noEmit` hold 830k more symbols and 870k more instantiations (#1671; 0.1.0-beta.43's rehearsal ran out of heap on
 * macOS). Every value is a zod schema by the modules that build the halves, and `RpcParams`/`RpcResult` read them as such.
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
