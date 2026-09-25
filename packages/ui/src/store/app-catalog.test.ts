import { describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol'
import type { AppModule } from '../apps/contract.js'
import { UNTRUSTED_REASON, appStatus, buildCatalog } from './app-catalog.js'

/**
 * 앱 명부 하나 (M4 A-8) — 내장 앱과 외부 앱이 같은 목록에 서고, 상태를 읽는 규칙이 한 곳에 있다.
 */

const info = (appId: string, over: Partial<ExternalAppInfo> = {}): ExternalAppInfo => ({
  appId, projectId: 'p1', dir: `/x/${appId}`, name: `App ${appId}`, version: '1', description: null, home: null,
  trusted: true, status: 'stopped', error: null, warnings: [], ...over,
})

const control: AppModule = { id: 'control', title: 'Control rail' }

describe('명부', () => {
  it('내장 앱과 외부 앱이 한 명부에 서고, 외부 앱은 범위(프로젝트·사용자 폴더)마다 이름순이다', () => {
    const c = buildCatalog([control], { control: { doc: null, enabled: false } }, [
      info('zeta', { name: 'Zeta' }),
      info('alpha', { name: 'Alpha' }),
      info('timer', { projectId: null, name: 'Timer' }),
      info('notes', { projectId: 'p2', name: null, status: 'invalid', error: 'bad json' }),
    ])
    expect(c.builtin).toEqual([expect.objectContaining({ kind: 'builtin', appId: 'control', title: 'Control rail', enabled: false })])
    expect(c.byProject['p1']?.map((a) => a.title)).toEqual(['Alpha', 'Zeta'])
    // 깨진 매니페스트에는 이름이 없다 — 폴더 이름으로 선다
    expect(c.byProject['p2']?.map((a) => [a.title, a.key])).toEqual([['notes', 'p2/notes']])
    expect(c.user.map((a) => a.key)).toEqual(['_user/timer'])
    // 같은 id라도 범위가 다르면 다른 앱이다
    expect(new Set(c.external.map((a) => a.key)).size).toBe(4)
  })
})

describe('상태를 읽는 규칙', () => {
  it('떠 있거나 쉬거나 뜨는 중인 앱, 죽었던 앱은 열 수 있다 — 죽었던 앱은 이유를 든다', () => {
    expect(appStatus(info('a', { status: 'running' }))).toMatchObject({ label: 'Running', runnable: true, reason: null })
    expect(appStatus(info('a', { status: 'stopped' }))).toMatchObject({ label: 'Stopped', runnable: true })
    expect(appStatus(info('a', { status: 'starting' }))).toMatchObject({ label: 'Starting', runnable: true, tone: 'busy' })
    expect(appStatus(info('a', { status: 'crashed', error: 'exited (code 7)' }))).toMatchObject({
      label: 'Crashed',
      runnable: true,
      reason: 'exited (code 7)',
      tone: 'alert',
    })
  })

  it('멈춘 앱, 신뢰하지 않은 프로젝트의 앱, 깨진 앱은 열 수 없고 이유가 있다', () => {
    expect(appStatus(info('a', { status: 'failed', error: 'cannot open the thing' }))).toMatchObject({
      label: 'Failed',
      runnable: false,
      reason: 'cannot open the thing',
    })
    expect(appStatus(info('a', { status: 'untrusted', trusted: false }))).toMatchObject({
      label: 'Not trusted',
      runnable: false,
      reason: UNTRUSTED_REASON,
    })
    expect(appStatus(info('a', { status: 'invalid', error: 'server.command is missing' }))).toMatchObject({
      label: 'Invalid',
      runnable: false,
      reason: 'server.command is missing',
    })
  })
})
