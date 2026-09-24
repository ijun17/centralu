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
 * "런타임을 만들지 못했다"를 던지는 대신 **값으로** 돌려준다.
 *
 * 그 실패는 진입 모듈이 화면에 그려야 하므로, 던져서 없어지면 안 된다. 모듈 최상위에서
 * 던지면 콘솔 한 줄만 남고 페이지는 빈 채로 남는데, VITE_HOST_TOKEN이 없을 때 실제로
 * 그랬다. 울타리를 main.tsx가 아니라 여기에 두는 이유는 시험할 수 있어야 하기 때문이다:
 * 진입 모듈은 DOM과 번들러와 살아 있는 host 없이는 import조차 되지 않는다 (#121).
 */
export function startPlatform<T>(search: string, env: BrowserEnv, create: PlatformFactories<T>): PlatformStartup<T> {
  try {
    return { platform: isMockMode(search) ? create.mock() : create.host(browserHostOptions(env)), error: null }
  } catch (error) {
    return { platform: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
