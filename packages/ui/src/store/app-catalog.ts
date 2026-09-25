import { useMemo } from 'react'
import type { ExternalAppInfo } from '@cc/protocol'
import type { AppModule } from '../apps/contract.js'
import { APPS } from '../apps/registry.js'
import { externalAppKey, useStore, type AppState } from './store.js'

/**
 * 앱 명부 하나 (M4 A-8) — 내장 앱과 외부 앱을 같은 목록으로.
 *
 * 둘은 사는 방식이 다르다. 내장 앱(`control`)은 컴파일된 모듈이고 켜고 끄는 것이 전부다. 외부
 * 앱은 host가 발견한 폴더와 그 프로세스라, 범위(프로젝트·사용자 폴더)와 상태(뜨는 중·멈춤·이유)가
 * 있다. 그래도 화면(설정의 앱 목록, 사이드바의 앱 줄, 고정 화면)은 "이 앱이 무엇이고 지금 어떤가"를
 * 한 곳에서 물어야 한다. 화면마다 두 출처를 따로 읽어 합치면, 상태를 읽는 규칙(예: 신뢰하지 않은
 * 프로젝트의 앱은 열 수 없다)이 화면 수만큼 생기고 언젠가 하나가 어긋난다.
 *
 * 이 파일이 스토어 **밖에** 있는 이유: 스토어는 내장 앱 명부를 모른다(명부 → 앱 → api → host의
 * 순환 금지, #97). 여기는 명부와 스토어를 둘 다 읽기만 한다.
 */

/** 상태를 사람에게 보이는 모양으로. 판정은 여기 한 곳이다 */
export type AppStatusView = {
  /** 한두 단어 — 목록과 사이드바 줄이 쓴다 */
  label: string
  /** 왜 그런가. 이유가 없는 상태(떠 있다, 쉬고 있다)는 null */
  reason: string | null
  /** 지금 열 수 있는가. 아니면 화면 대신 이유와 할 일(신뢰하기, 다시 시작하기)을 보인다 */
  runnable: boolean
  /** 목록에서의 밝기 — 막혀서 사람이 봐야 하는 것만 밝다(팔레트 규칙) */
  tone: 'quiet' | 'busy' | 'alert'
}

export type BuiltinCatalogApp = {
  kind: 'builtin'
  key: string
  appId: string
  title: string
  module: AppModule
  enabled: boolean
}

export type ExternalCatalogApp = {
  kind: 'external'
  /** `externalAppKey` — 앱은 (프로젝트, id)로 하나다 */
  key: string
  appId: string
  /** null은 사용자 폴더 앱 */
  projectId: string | null
  /** 매니페스트의 이름, 없으면(깨진 매니페스트) 폴더 이름 */
  title: string
  info: ExternalAppInfo
  status: AppStatusView
}

export type AppCatalog = {
  builtin: BuiltinCatalogApp[]
  external: ExternalCatalogApp[]
  /** 프로젝트 id → 그 프로젝트의 앱 (이름순) */
  byProject: Record<string, ExternalCatalogApp[]>
  /** 사용자 폴더의 앱 (이름순) */
  user: ExternalCatalogApp[]
}

export const UNTRUSTED_REASON = "This project isn't trusted, so its apps don't run."

export function appStatus(info: ExternalAppInfo): AppStatusView {
  switch (info.status) {
    case 'running':
      return { label: 'Running', reason: null, runnable: true, tone: 'quiet' }
    case 'stopped':
      return { label: 'Stopped', reason: null, runnable: true, tone: 'quiet' }
    case 'starting':
      return { label: 'Starting', reason: null, runnable: true, tone: 'busy' }
    case 'crashed':
      // 다음에 부르면 (백오프 뒤) 다시 뜬다 — 열 수는 있다
      return { label: 'Crashed', reason: info.error, runnable: true, tone: 'alert' }
    case 'failed':
      return { label: 'Failed', reason: info.error ?? 'It failed to start several times in a row.', runnable: false, tone: 'alert' }
    case 'untrusted':
      return { label: 'Not trusted', reason: UNTRUSTED_REASON, runnable: false, tone: 'quiet' }
    case 'unconfirmed':
      /*
       * 가져온 앱이 사람의 확인을 기다린다 (M4 E-3) — 처음 들어와 아직 켜지 않았거나, 켠 뒤 무엇을 돌리는지(server)나 무엇을
       * 쓰겠다는지(uses)가 바뀌었다. 둘 다 사람이 보고 켜야 풀린다. 이유는 host의 말이다.
       */
      return {
        label: info.imported?.confirmedAt ? 'Needs review' : 'Not enabled',
        reason: info.error ?? 'This app was imported and is not enabled yet.',
        runnable: false,
        tone: 'alert',
      }
    case 'invalid':
      return { label: 'Invalid', reason: info.error ?? 'The app manifest could not be read.', runnable: false, tone: 'alert' }
  }
}

const byTitle = (a: ExternalCatalogApp, b: ExternalCatalogApp) => a.title.localeCompare(b.title) || a.appId.localeCompare(b.appId)

/**
 * 순수 계산 — 훅과 시험이 같이 쓴다.
 *
 * 순서는 이름순이다. 세션처럼 끌어서 정한 순서를 host에 적을 자리가 아직 없고, 발견 순서(폴더를
 * 읽은 순서)는 파일 시스템마다 달라 사이드바의 줄이 기동마다 뒤섞일 수 있다.
 */
export function buildCatalog(
  builtins: readonly AppModule[],
  builtinState: AppState['apps'],
  external: readonly ExternalAppInfo[],
): AppCatalog {
  const ext: ExternalCatalogApp[] = external.map((info) => ({
    kind: 'external',
    key: externalAppKey(info.projectId, info.appId),
    appId: info.appId,
    projectId: info.projectId,
    title: info.name ?? info.appId,
    info,
    status: appStatus(info),
  }))
  ext.sort(byTitle)
  const byProject: Record<string, ExternalCatalogApp[]> = {}
  const user: ExternalCatalogApp[] = []
  for (const a of ext) {
    if (a.projectId === null) user.push(a)
    else (byProject[a.projectId] ??= []).push(a)
  }
  return {
    builtin: builtins.map((m) => ({
      kind: 'builtin',
      key: `builtin/${m.id}`,
      appId: m.id,
      title: m.title,
      module: m,
      enabled: builtinState[m.id]?.enabled ?? true,
    })),
    external: ext,
    byProject,
    user,
  }
}

export function useAppCatalog(): AppCatalog {
  const builtinState = useStore((s) => s.apps)
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog(APPS, builtinState, external), [builtinState, external])
}

const NONE: ExternalCatalogApp[] = []

/** 한 프로젝트의 앱 — 사이드바의 프로젝트 블록이 쓴다 */
export function useProjectApps(projectId: string): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog([], {}, external).byProject[projectId] ?? NONE, [external, projectId])
}

/** 사용자 폴더의 앱 — 프로젝트에 속하지 않으므로 사이드바에 자기 무리가 있다 */
export function useUserApps(): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog([], {}, external).user, [external])
}

/** 앱 하나 — 없으면(폴더가 사라졌다, 프로젝트를 지웠다) undefined */
export function useExternalApp(projectId: string | null, appId: string): ExternalCatalogApp | undefined {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => {
    const info = external.find((a) => a.appId === appId && a.projectId === projectId)
    return info ? buildCatalog([], {}, [info]).external[0] : undefined
  }, [external, projectId, appId])
}
