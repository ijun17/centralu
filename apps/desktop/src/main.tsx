import { createRoot } from 'react-dom/client'
import { App } from '@cc/ui'
import { createTauriPlatform, focusWindow } from '@cc/platform/tauri'
import '../../../packages/ui/src/styles/index.css'

/**
 * 데스크톱 진입점 — 구현체를 아는 두 곳 중 하나 (docs/platform-abstraction.md §4).
 * apps/web과 다른 것은 createTauriPlatform 한 줄뿐이다.
 */
const root = createRoot(document.getElementById('root')!)

// **먼저 무언가를 그린다.** host를 기다리는 동안 아무것도 렌더하지 않으면
// 빈 검은 창이 뜨고, 그건 고장으로 보인다 (도그푸딩에서 지적됨).
root.render(<Starting />)

createTauriPlatform()
  .then(async (platform) => {
    root.render(<App platform={platform} />)
    await registerGlobalShortcut()
  })
  .catch((err: Error) => root.render(<StartupFailure message={err.message} />))

function Starting() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-void" data-testid="starting">
      <p className="text-[13px] text-ash">Starting the agent host…</p>
      {/* Not "macOS may ask": it is the OS that asks, and on Linux nothing asks at all.
          Naming one OS in a message every platform sees makes it read as a bug elsewhere. */}
      <p className="text-[11px] text-slate">On first run, your system may ask for folder access.</p>
    </div>
  )
}

/** host가 뜨지 않으면 앱이 빈 화면으로 남지 않게, 무엇이 잘못됐는지 보여준다 */
function StartupFailure({ message }: { message: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-void px-8 text-center">
      <p className="text-[13px] text-chalk">Could not start the agent host</p>
      {/* 사이드카가 준 문장은 여러 줄이다 (무엇이 없는지, 어디를 찾아봤는지) — 줄을 살려서 보여준다 */}
      <p className="max-w-md whitespace-pre-line font-mono text-[11px] leading-relaxed text-ash">{message}</p>
      <p className="max-w-md text-[11px] leading-relaxed text-slate">
        If restarting hits the same problem, check <span className="font-mono">~/.centralu/host.log</span>.
      </p>
      <button
        className="mt-1 rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk hover:border-graphite"
        onClick={() => location.reload()}
      >
        Retry
      </button>
    </div>
  )
}

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
    console.warn('Could not register the global shortcut', e)
  }
}
