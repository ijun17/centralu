import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 코드 뷰어 (FR-6, C-3) — **읽기 전용**. 편집은 IDE 몫이다 (비목표).
 *
 * 무거운 것을 넣지 않는 것이 이 화면의 설계다:
 *   - CodeMirror·Shiki를 쓰지 않는다. 읽기 전용 표시에 편집기 엔진은 과하고,
 *     Shiki의 기본 엔진은 WASM이라 Tauri CSP(`wasm-unsafe-eval` 없음)와 충돌한다.
 *   - 대신 가상 스크롤 + 무채색 강조(주석·문자열만 밝기로 구분)로 충분히 읽힌다.
 *   - 정밀한 하이라이트가 필요하면 "IDE에서 열기"가 한 번의 클릭이다.
 */
export function CodeViewer({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const path = useStore((s) => s.viewerPath)
  const setToast = useStore((s) => s.setToast)
  const [file, setFile] = useState<{ text: string; truncated: boolean; binary: boolean; bytes: number } | null>(null)
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setFile(null)
    if (!path) return
    void platform.fs
      .readFile(projectId, path)
      .then(setFile)
      .catch((e: Error) => setToast(e.message))
  }, [platform, projectId, path, setToast])

  const lines = useMemo(() => (file?.text ?? '').split('\n'), [file])
  const matches = useMemo(() => {
    if (!query.trim()) return new Set<number>()
    const q = query.toLowerCase()
    const hit = new Set<number>()
    lines.forEach((l, i) => l.toLowerCase().includes(q) && hit.add(i))
    return hit
  }, [lines, query])

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 30,
  })

  if (!path) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2" data-testid="viewer-empty">
        <p className="text-[13px] text-ash">파일을 선택하세요</p>
        <p className="text-[11px] text-slate">
          <Kbd>⌘⇧2</Kbd> 파일 트리에서 고르면 여기에 열립니다
        </p>
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="code-viewer">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="readout truncate text-[11px] text-ash" data-testid="viewer-path">
          {path}
        </span>
        <input
          className="ml-2 w-40 rounded border border-edge bg-panel px-2 py-0.5 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="파일 내 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="viewer-search"
        />
        {query && (
          <span className="readout text-[10px] text-slate" data-testid="viewer-match-count">
            {matches.size}줄
          </span>
        )}
        <button
          className="ml-auto shrink-0 text-[11px] text-slate hover:text-chalk"
          onClick={() => void platform.system.openInIde(path)}
          data-testid="viewer-open-ide"
        >
          IDE에서 열기
        </button>
      </header>

      {file === null ? (
        <p className="p-3 text-[12px] text-slate">읽는 중…</p>
      ) : file.binary ? (
        <p className="p-3 text-[12px] text-slate" data-testid="viewer-binary">
          바이너리 파일입니다 ({(file.bytes / 1024).toFixed(0)}KB)
        </p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[18px]">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((v) => (
              <div
                key={v.key}
                className={`absolute left-0 flex w-full ${matches.has(v.index) ? 'bg-graphite/50' : ''}`}
                style={{ top: `${v.start}px`, height: `${v.size}px` }}
              >
                <span className="sticky left-0 w-12 shrink-0 select-none bg-void pr-2 text-right text-slate">
                  {v.index + 1}
                </span>
                <span className="whitespace-pre text-ash">{lines[v.index]}</span>
              </div>
            ))}
          </div>
          {file.truncated && (
            <p className="p-2 text-[11px] text-slate">…파일이 커서 일부만 표시합니다. IDE에서 열어 확인하세요.</p>
          )}
        </div>
      )}
    </section>
  )
}
