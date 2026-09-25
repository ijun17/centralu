import { useCallback, useEffect, useRef, useState } from 'react'
import { newAppIdProblem, type ToolName, type ToolStatus } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { APPS } from '../../apps/registry.js'
import { Modal } from '../../components/Modal.jsx'
import { useToolMeta, useTools } from '../../store/selectors.js'
import { useStore } from '../../store/store.js'
import { appIdHint, deriveAppId } from './newAppId.js'

/** 칸 하나의 생김새 — 새 세션 창과 같은 모양이어야 "같은 종류의 창"으로 읽힌다 */
const inputClass =
  'w-full rounded border border-edge bg-void px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none'

/** 내장 앱의 id — 외부 앱은 가져갈 수 없다(host의 reservedIds와 같은 명부) */
const BUILTIN_IDS = APPS.map((a) => a.id)

/**
 * 새 앱 (M4 C-1) — 이름과 만드는 에이전트를 묻고, host가 템플릿으로 앱을 펼치고 그 앱의 만드는 세션을 세운다.
 *
 * 묻는 것은 둘이다. **이름**(사람이 부를 말)과 **누가 만드나**(만드는 세션의 도구). id는 이름에서 지어 보여 주고
 * 고칠 수 있게 둔다 — 폴더 이름이자 세션의 서버 이름이라 규칙이 있고(newAppId.ts), 판정은 host와 한 벌이다
 * (`newAppIdProblem`). 창이 먼저 막는 것은 모양뿐이다: 이미 있는 id·신뢰·템플릿은 host가 판정하고, 거절하면 그 말을
 * **그대로** 보인다. 창이 host의 말을 제 말로 바꿔 적으면, 둘이 어긋나는 날 사람은 틀린 이유를 읽는다.
 *
 * 도구는 새 세션 창과 같은 규칙이다: 열 때마다 다시 감지하고(방금 로그인했을 수 있다), 기본 도구를 못 쓰면 쓸 수 있는
 * 쪽으로 한 번 옮기고, 못 쓰는 도구를 골랐으면 까닭과 고치는 명령을 말한다. 못 쓰는 도구로는 만들지 않는다 — 앱은
 * 서도 만드는 세션이 서지 못하면, 사람은 고칠 사람이 없는 앱 앞에 선다.
 *
 * 신뢰하지 않은 프로젝트에는 host가 앱을 만들지 않는다(앱은 이 기계에서 도는 코드다). 거절을 받기 전에 그 사실을
 * 말하고, 그 자리에서 신뢰할 수 있게 한다.
 */
export function NewAppDialog({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const orchestratorTool = useStore((s) => (s.orchestratorId ? s.sessions[s.orchestratorId]?.tool : undefined))
  const createApp = useStore((s) => s.createApp)
  const setProjectTrusted = useStore((s) => s.setProjectTrusted)
  const allTools = useTools()
  /*
   * 기본 도구는 host가 고를 것과 같게 짐작한다 — 프로젝트 앱은 그 프로젝트의 기본, 사용자 폴더 앱은 오케스트레이터의
   * 도구. 짐작이 틀려도 창은 **고른 도구를 늘 실어 보낸다**: 보여 준 필과 다른 도구로 세션이 서는 일이 없다.
   */
  const [tool, setTool] = useState<ToolName>(
    (projectId ? project?.defaultTool : orchestratorTool) ?? allTools[0]?.name ?? '',
  )
  const toolMeta = useToolMeta(tool)
  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [name, setName] = useState('')
  /** 사람이 id를 손댔으면 그 값, 아니면 null — 이름을 고치는 동안 지은 id가 따라간다 */
  const [idEdit, setIdEdit] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const id = idEdit ?? deriveAppId(name)
  const problem = newAppIdProblem(id, BUILTIN_IDS)
  const untrusted = !!project && !project.trusted

  // 열 때마다 감지한다 — 사용자가 방금 설치·로그인했을 수 있다
  const detect = useCallback(async () => {
    try {
      setTools(await platform.agents.detect())
    } catch {
      setTools([])
    }
  }, [platform])
  useEffect(() => {
    void detect()
  }, [detect])

  // 기본 도구를 못 쓰는데 다른 하나가 멀쩡하면 **한 번만** 옮긴다(새 세션 창과 같은 규칙) — 그 뒤 고른 것은 두고 본다
  const autoPicked = useRef(false)
  useEffect(() => {
    if (!tools || autoPicked.current) return
    autoPicked.current = true
    const ok = (t: ToolName) => {
      const d = tools.find((x) => x.name === t)
      return d?.installed === true && d.loggedIn
    }
    setTool((cur) => (ok(cur) ? cur : (tools.find((x) => x.installed && x.loggedIn)?.name ?? cur)))
  }, [tools])

  const info = (t: ToolName) => tools?.find((x) => x.name === t)
  const usable = (t: ToolName) => {
    const d = info(t)
    return !tools || (d?.installed === true && d.loggedIn)
  }
  const blocked = tools ? !usable(tool) : false
  const canCreate = !busy && name.trim() !== '' && problem === null && !blocked && !untrusted && tool !== ''

  return (
    <Modal onClose={onClose} testId="new-app-dialog" align="top">
      <form
        className="flex w-[440px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!canCreate) return
          setBusy(true)
          setError(null)
          try {
            await createApp({ projectId, id, name: name.trim(), tool })
            onClose()
          } catch (err) {
            // host의 말 그대로 — 토스트는 2.5초 뒤 사라져 "눌러도 아무 일이 없다"로 보인다. 창 안에 남긴다
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <header className="shrink-0 border-b border-edge px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-chalk">
            New app <span className="text-slate">·</span>{' '}
            <span className="text-ash">{project ? project.name : 'Your apps'}</span>
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-slate">
            {projectId
              ? 'Lives in this project, in .centralu/apps, and is shared with the repository.'
              : 'Lives on this machine and works in every project.'}
          </p>
        </header>

        <div className="space-y-3 px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-[10px] text-ash">Name</span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Resource search"
              maxLength={80}
              spellCheck={false}
              className={inputClass}
              data-testid="new-app-name"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-ash">
              Id <span className="text-slate">· folder name, and how agents see it (app-{id || '…'})</span>
            </span>
            <input
              type="text"
              value={id}
              onChange={(e) => setIdEdit(e.target.value)}
              placeholder="resource-search"
              spellCheck={false}
              className={`${inputClass} font-mono text-[11px]`}
              data-testid="new-app-id"
              aria-invalid={problem !== null || undefined}
            />
            {problem !== null && (name.trim() !== '' || idEdit !== null) && (
              <span className="mt-1 block text-[11px] leading-relaxed text-ash" data-testid="new-app-id-problem">
                {appIdHint(id, problem)}
              </span>
            )}
          </label>

          <div>
            <p className="mb-1 text-[10px] text-ash">Built by</p>
            <div className="flex gap-1.5">
              {allTools.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setTool(t.name)}
                  data-testid={`new-app-tool-${t.name}`}
                  aria-pressed={tool === t.name}
                  title={info(t.name)?.detail}
                  className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                    tool === t.name
                      ? 'border-ash bg-graphite/40 text-chalk'
                      : 'border-edge text-ash hover:border-graphite hover:text-chalk'
                  } ${tools && !usable(t.name) ? 'opacity-50' : ''}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {/* 못 쓰는 이유를 숨기지 않는다 — 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다 */}
            {blocked && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ash" data-testid="new-app-tool-blocked">
                {info(tool)?.installed
                  ? `${toolMeta.label} needs a login. Run ${toolMeta.login} in a terminal, then open this again.`
                  : `${toolMeta.label} is not installed (${info(tool)?.detail ?? 'not found'}).`}
              </p>
            )}
            {!blocked && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate">
                A builder session with {toolMeta.label} starts with the app. Ask it for changes while you use the app.
              </p>
            )}
          </div>

          {untrusted && project && (
            <div className="rounded border border-edge bg-panel px-2.5 py-2" data-testid="new-app-untrusted">
              <p className="text-[11px] leading-relaxed text-ash">
                Apps only run in projects you trust. Trust {project.name} to make an app here.
              </p>
              <button
                type="button"
                className="mt-1.5 rounded border border-edge bg-void px-2.5 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite"
                onClick={() => void setProjectTrusted(project.id, true)}
                data-testid="new-app-trust"
              >
                Trust this project
              </button>
            </div>
          )}

          {error && (
            <p
              className="whitespace-pre-wrap break-words rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk"
              role="alert"
              data-testid="new-app-error"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-edge px-4 py-2.5">
          <button type="button" className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={!canCreate}
            data-testid="new-app-create"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
