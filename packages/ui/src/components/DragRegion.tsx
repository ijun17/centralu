import { useRef, type CSSProperties, type ReactNode } from 'react'
import { usePlatform } from '../app/PlatformProvider.jsx'
import { useStore } from '../store/store.js'

/**
 * 창을 끄는 손잡이.
 *
 * `data-tauri-drag-region` 속성만으로는 부족하다: 그 속성은 **mousedown이 실제로
 * 꽂힌 요소 자신**에 있어야 해서, 헤더 안의 글자나 아이콘을 잡으면 그냥 죽는다.
 * 속성을 자식마다 뿌려도 새 자식이 생기면 또 구멍이 난다 —
 * "가끔은 되고 가끔은 안 된다"가 그래서 나온다 (도그푸딩에서 두 번 지적됨).
 *
 * 그래서 영역 전체에서 mousedown을 받아, 누른 곳이 조작할 것(버튼·입력)이 아니면
 * 우리가 직접 끌기를 시작한다. 잡을 수 있는 곳 = 눈에 보이는 빈 곳 전부가 된다.
 */
export function DragRegion({
  children,
  className,
  style,
  testId,
}: {
  children?: ReactNode
  className?: string
  /** For lengths that are not ours to hardcode — e.g. the room the OS window controls need */
  style?: CSSProperties
  testId?: string
}) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const warned = useRef(false)

  return (
    <div
      className={className}
      style={style}
      data-testid={testId}
      // 속성도 함께 둔다 — 네이티브 경로가 먼저 잡아주면 그게 더 매끄럽다
      data-tauri-drag-region
      onMouseDown={(e) => {
        if (e.button !== 0) return
        const el = e.target as HTMLElement
        // 조작할 것 위에서는 끌지 않는다. 여기서 막지 않으면 버튼이 안 눌린다
        if (el.closest('button, a, input, textarea, select, label, [role="button"], [data-no-drag]')) return
        void platform.system.startWindowDrag().catch((err: Error) => {
          // 삼키지 않는다. 실제로 이것 때문에 창이 안 움직이는 걸 세 번 놓쳤다 —
          // Tauri 권한(core:window:allow-start-dragging)이 빠지면 여기서 거부된다.
          if (warned.current) return
          warned.current = true
          setToast(`Could not move window: ${err.message}`)
        })
      }}
      onDoubleClick={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('button, a, input, textarea, select, label')) return
        // macOS 관례: 타이틀바 더블클릭 = 확대. 네이티브가 알아서 하도록 둔다
      }}
    >
      {children}
    </div>
  )
}
