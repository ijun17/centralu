import { useStore } from '../../store/store.js'
import { Tooltip } from '../../components/primitives.jsx'

/**
 * "새 버전이 있습니다" — 계기판의 조용한 한 줄 (이슈 #43).
 *
 * **할 말이 있을 때만 나타난다.** 상단 바에서 단축키 칩을 걷어낸 이유가 그거였다
 * (이슈 #33): 늘 켜져 있는 것은 볼 때마다 주의를 걷어가면서 처음 한 번 뒤로는
 * 아무것도 알려주지 않는다. 이 줄은 반대다 — 평소엔 아예 없고, 레지스트리에 새것이
 * 올라온 동안에만 있다가 다시 사라진다. 그래서 계기판에 설 자격이 있다.
 *
 * **누르는 것이 곧 동의다.** 그래서 라벨이 "New version available"이 아니라
 * "Update to 9.9.9"다 — 버튼은 자기가 무슨 일을 할지 적고 있어야 하고, 이건 되돌릴 수
 * 없는 일이다. 그리고 끝나도 **다시 시작하지 않는다.** 도는 앱을 갈아 끼우는 결정은
 * 대화 중간일 수도 있는 사람의 몫이고, 이 줄이 그 말을 하는 자리다.
 */
export function UpdateLine() {
  const update = useStore((s) => s.update)
  const applyUpdate = useStore((s) => s.applyUpdate)
  if (!update) return null

  const tone = 'text-[11px] leading-none'

  if (update.phase === 'updating') {
    return (
      <span className={`${tone} text-slate`} data-testid="update-line" role="status">
        Updating…
      </span>
    )
  }

  if (update.phase === 'restart_required') {
    return (
      // ash, not slate: this one is asking for something. Not beacon either — nothing is
      // blocked, and the brightest thing on screen stays reserved for what waits on me.
      <span className={`${tone} text-ash`} data-testid="update-line" role="status">
        Restart Centralu to finish updating{update.latest ? ` to ${update.latest}` : ''}
      </span>
    )
  }

  if (update.phase === 'failed') {
    /*
     * 실패한 설치는 조용히 넘기지 않는다 — 확인 실패와 다르다.
     *
     * 확인은 아무도 안 시켰으니 조용히 실패해도 되지만, 설치는 사람이 눌러서 시작한
     * 일이다. 아무 말 없이 원래대로 돌아가면 "눌렀는데 아무 일도 안 일어났다"가 되고,
     * 그러면 다음에 또 누른다. 이유는 길 수 있어서 물어볼 때만 편다.
     */
    return (
      <Tooltip content={update.error ?? 'Something went wrong'} testId="update-error" align="right">
        <span className={`${tone} text-beacon`} data-testid="update-line">
          Update failed
        </span>
      </Tooltip>
    )
  }

  if (!update.newer || !update.latest) return null

  return (
    <button
      type="button"
      className={`rounded px-2 py-1 ${tone} text-slate transition-colors hover:bg-graphite/50 hover:text-chalk`}
      data-testid="update-line"
      onClick={() => void applyUpdate()}
      title={`Install ${update.latest} (you will be asked to restart, never restarted for you)`}
    >
      Update to {update.latest}
    </button>
  )
}
