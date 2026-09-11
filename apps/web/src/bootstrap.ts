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
  return new URLSearchParams(search).has('mock')
}

export function browserHostOptions(env: BrowserEnv): BrowserHostOptions {
  const token = env.VITE_HOST_TOKEN
  if (!token) throw new MissingHostTokenError()

  return {
    hostUrl: env.VITE_HOST_URL ?? DEFAULT_HOST_URL,
    token,
  }
}
