import { createRoot } from 'react-dom/client'
import { App } from '@cc/ui'
import { createTauriPlatform, focusWindow } from '@cc/platform/tauri'
import '../../../packages/ui/src/styles/index.css'

/**
 * 데스크톱 진입점 — 구현체를 아는 두 곳 중 하나 (docs/platform-abstraction.md §4).
 * apps/web과 다른 것은 이 한 줄(createTauriPlatform)뿐이다.
 */
const root = createRoot(document.getElementById('root')!)

createTauriPlatform()
  .then(async (platform) => {
    root.render(<App platform={platform} />)
    await registerGlobalShortcut()
  })
  .catch((err: Error) => root.render(<StartupFailure message={err.message} />))

/**
 * 앱이 백그라운드일 때도 대기 세션을 부를 수 있어야 한다 (FR-17, B-4).
 * 창을 앞으로 가져온 뒤 UI의 "다음 대기로 이동"을 그대로 실행한다.
 */
async function registerGlobalShortcut() {
  try {
    const { register, isRegistered } = await import('@tauri-apps/plugin-global-shortcut')
    const accelerator = 'CommandOrControl+Shift+A'
    if (await isRegistered(accelerator)) return
    await register(accelerator, async (event) => {
      if (event.state !== 'Pressed') return
      await focusWindow()
      window.dispatchEvent(new CustomEvent('cc:next-waiting'))
    })
  } catch (e) {
    // 단축키가 이미 다른 앱에 잡혀 있어도 앱은 정상 동작해야 한다
    console.warn('전역 단축키를 등록하지 못했습니다', e)
  }
}

/** host가 뜨지 않으면 앱이 빈 화면으로 남지 않게, 무엇이 잘못됐는지 보여준다 */
function StartupFailure({ message }: { message: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-void px-8 text-center">
      <p className="text-[13px] text-chalk">에이전트 호스트를 시작하지 못했습니다</p>
      <p className="max-w-md font-mono text-[11px] leading-relaxed text-ash">{message}</p>
      <p className="text-[11px] text-slate">앱을 다시 실행해도 같은 문제가 반복되면 터미널에서 로그를 확인하세요.</p>
    </div>
  )
}
