const DEFAULT_HOST_URL = 'ws://127.0.0.1:5175'

export class MissingHostTokenError extends Error {
  constructor() {
    super('VITE_HOST_TOKEN is required for non-mock browser runtime')
    this.name = 'MissingHostTokenError'
  }
}

type BrowserEnv = {
  readonly VITE_HOST_URL?: string
  readonly VITE_HOST_TOKEN?: string
}

export type BrowserHostOptions = {
  readonly hostUrl: string
  readonly token: string
}

export function isMockMode(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('mock') || params.has('demo')
}

export function browserHostOptions(env: BrowserEnv): BrowserHostOptions {
  const token = env.VITE_HOST_TOKEN?.trim()
  if (!token) throw new MissingHostTokenError()

  return {
    hostUrl: env.VITE_HOST_URL ?? DEFAULT_HOST_URL,
    token,
  }
}

export type PlatformFactories<T> = {
  readonly mock: () => T
  readonly host: (options: BrowserHostOptions) => T
}

export type PlatformStartup<T> =
  | { readonly platform: T; readonly error: null }
  | { readonly platform: null; readonly error: Error }

/**
 * Returns "could not build the runtime" **as a value** instead of throwing it.
 *
 * That failure has to be drawn on screen by the entry module, so it cannot disappear by being
 * thrown. Throwing at the top of a module leaves only one console line and an otherwise blank
 * page — which is exactly what happened when VITE_HOST_TOKEN was missing. The reason this
 * boundary lives here rather than in main.tsx is that it has to be testable: the entry module
 * cannot even be imported without a DOM, a bundler and a live host (#121).
 */
export function startPlatform<T>(search: string, env: BrowserEnv, create: PlatformFactories<T>): PlatformStartup<T> {
  try {
    return { platform: isMockMode(search) ? create.mock() : create.host(browserHostOptions(env)), error: null }
  } catch (error) {
    return { platform: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
