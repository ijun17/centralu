import { useState } from 'react'
import type { ProjectInfo } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { Modal } from '../../components/Modal.jsx'

/**
 * 프로젝트 삭제 (도그푸딩 요청).
 *
 * **되돌릴 수 없는 일이 둘 있고, 크기가 다르다.** 하나는 이 앱의 기억(세션·대화·검색
 * 색인)이 사라지는 것이고, 다른 하나는 디스크의 폴더가 사라지는 것이다. 그래서 이 창은
 * 기본값으로 앞의 것만 하고, 뒤의 것은 사람이 직접 켜야 한다 — 그리고 켜는 순간
 * **설명문이 경고문으로 바뀐다.** 같은 자리에서 문장이 바뀌므로, 무엇이 달라졌는지
 * 읽으러 다른 곳을 볼 필요가 없다.
 *
 * 이름을 치게 하는 이유: 이 창에는 실수로 지나갈 수 있는 길이 없어야 한다. 확인 버튼
 * 하나짜리 창은 손이 기억으로 지나가고, 지나간 뒤에는 되돌릴 것이 없다. 이름을 치는
 * 동안 사람은 자기가 무엇을 지우는지 한 번 읽는다 — 그게 이 장치의 전부다.
 *
 * 파일은 **휴지통으로** 간다. 앱의 파일 규칙 그대로다 (fs 포트: "Not a delete — that is
 * the whole decision"). 되돌릴 길을 OS가 하나 남겨두는 편이, 우리가 rm을 부르고
 * 사람의 미커밋 작업을 영영 없애는 것보다 낫다.
 */
export function DeleteProjectDialog({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const deleteProject = useStore((s) => s.deleteProject)
  const [typed, setTyped] = useState('')
  const [withFiles, setWithFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 공백만 흘리고 정확히 같아야 한다 — 대소문자까지. 비슷한 이름의 프로젝트가 이웃일 수 있다
  const armed = typed.trim() === project.name

  return (
    <Modal onClose={onClose} testId="delete-project-dialog">
      <form
        className="w-[420px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!armed || busy) return
          setBusy(true)
          setError(null)
          try {
            await deleteProject(project.id, withFiles)
            onClose()
          } catch (err) {
            // 토스트는 2.5초 뒤 사라져 '눌러도 아무 일이 없다'로 보인다 — 창 안에 남긴다
            setError((err as Error).message)
            setBusy(false)
          }
        }}
      >
        <h2 className="text-[13px] font-medium text-chalk">
          Delete project <span className="text-slate">·</span>{' '}
          <span className="text-ash">{project.name}</span>
        </h2>

        {/*
          같은 자리에서 설명이 경고로 바뀐다. 두 문장을 함께 띄우면 어느 쪽이 지금
          벌어질 일인지 사람이 골라 읽어야 하는데, 그 고르기는 여기서 하면 안 되는 일이다.
        */}
        {/*
          위험한 상태는 **빨갛다** (도그푸딩 요청). 색은 diff의 삭제 팔레트(--color-del)를
          그대로 쓴다 — 이 앱에서 빨강은 이미 "없어지는 것"의 색이라, 새 언어를
          만드는 게 아니라 있는 언어를 넓히는 것이다. 제일 아픈 문장(커밋 안 된
          작업까지 간다)이 제일 진하다.
        */}
        {withFiles ? (
          <p
            className="mt-2 rounded border border-del/40 bg-del-bg px-2.5 py-2 text-[11px] leading-relaxed text-chalk"
            data-testid="delete-project-warning"
          >
            The folder itself goes to the Trash — <span className="readout text-ash">{project.path}</span> and
            everything inside it, <span className="text-del">including work the agents have not committed</span>.
            Centralu’s records go with it.
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-relaxed text-ash" data-testid="delete-project-note">
            Only what Centralu remembers is deleted — sessions, their conversations, the search index and the
            always-allow rules. <span className="text-chalk">The folder on disk is left alone.</span>
          </p>
        )}

        <label
          className={`mt-3 flex cursor-pointer items-start gap-2 text-[11px] ${
            withFiles ? 'text-del' : 'text-ash hover:text-chalk'
          }`}
          data-testid="delete-project-files-toggle"
        >
          {/* 켜는 순간 체크도 빨갛다 — 경고문과 같은 palette, 같은 순간 */}
          <input
            type="checkbox"
            className={`mt-0.5 ${withFiles ? 'accent-del' : 'accent-ash'}`}
            checked={withFiles}
            onChange={(e) => setWithFiles(e.target.checked)}
          />
          <span>Move the folder to the Trash too</span>
        </label>

        {/*
          이름을 치는 칸은 **맨 아래**다. 위의 설명(또는 경고)을 읽고 내려오는 순서가
          되어야, 치는 동작이 읽은 것에 대한 답이 된다.
        */}
        <label className="mt-3 block text-[11px] text-ash" htmlFor="delete-project-name">
          Type <span className="readout text-chalk">{project.name}</span> to confirm
        </label>
        <input
          id="delete-project-name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          data-testid="delete-project-name-input"
          className="mt-1 w-full rounded border border-edge bg-void px-2 py-1.5 font-mono text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
        />

        {error && (
          <p
            className="mt-3 rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk"
            data-testid="delete-project-error"
          >
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk"
          >
            Cancel
          </button>
          {/* 실행 버튼도 삭제 팔레트다 — 되돌릴 수 없는 일의 방아쇠가 중립색이면 안 된다 */}
          <button
            type="submit"
            disabled={!armed || busy}
            data-testid="delete-project-confirm"
            className="rounded border border-del/40 bg-del-bg px-3 py-1 text-[12px] text-del transition-colors hover:border-del/70 disabled:opacity-40"
          >
            {busy ? 'Deleting…' : withFiles ? 'Delete and trash folder' : 'Delete'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
