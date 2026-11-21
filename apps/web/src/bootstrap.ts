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
 * The failure as a value: thrown at a module's top it leaves one console line and a blank page. Here, not in main.tsx,
 * so it is testable: the entry cannot be imported without a DOM, a bundler and a live host (#121).
 */
export function startPlatform<T>(search: string, env: BrowserEnv, create: PlatformFactories<T>): PlatformStartup<T> {
  try {
    return { platform: isMockMode(search) ? create.mock() : create.host(browserHostOptions(env)), error: null }
  } catch (error) {
    return { platform: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
