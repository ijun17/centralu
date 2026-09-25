import type { AppReview, AppUses } from '@cc/protocol'

/**
 * 켜기 전에 사람이 보는 것 (M4 E-3) — 가져올 앱(또는 다시 물어야 하는 가져온 앱)이 **무엇을 돌리는지**, **무엇을 쓰겠다는지**, 어떤
 * 비밀을 원하는지, 어떤 파일이 들어오는지. 가져오기 창과 고정 화면의 확인이 이 하나를 같이 쓴다.
 *
 * 순서가 곧 중요도다. 명령이 맨 위에 선다: 앱 서버는 이 기계에서 사람의 권한으로 도는 코드라(샌드박스는 화면에만 걸린다), 켜는 것은
 * 곧 이 명령을 돌려도 된다는 말이다. 다시 묻는 것이면 무엇이 바뀌었는지가 그보다 먼저 선다 — 다시 묻는 까닭이 그것이다.
 */
export function AppReviewDetails({ review }: { review: AppReview }) {
  const uses = usesLines(review.uses)
  return (
    <div className="space-y-3 text-[12px]" data-testid="app-review">
      <div>
        <p className="text-[13px] text-chalk">
          <span data-testid="review-name">{review.name}</span> <span className="readout text-[10px] text-slate">v{review.version}</span>{' '}
          <span className="readout text-[10px] text-slate">{review.appId}</span>
        </p>
        <p className="mt-0.5 break-words text-[11px] text-slate" data-testid="review-source">
          From {review.source}
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-ash">{review.description}</p>
      </div>

      {review.changed && (
        <Section title="Changed since you enabled it" testId="review-changed" tone="alert">
          {review.changed.server && (
            <p className="text-ash">
              It used to run <Command server={review.changed.was.server} testId="review-command-was" />
            </p>
          )}
          {review.changed.uses && (
            <p className="text-ash">
              It used to ask for:{' '}
              {usesLines(review.changed.was.uses).join('; ') || 'nothing beyond its own tools'}
            </p>
          )}
        </Section>
      )}

      <Section title="What it runs" testId="review-runs">
        <Command server={review.server} />
        <p className="mt-1 text-[11px] leading-relaxed text-slate">
          In its own folder, as you: it can read your files, use the network and start programs. Only its screen is sandboxed.
        </p>
      </Section>

      <Section title="What it asks Centralu for" testId="review-uses">
        {uses.length === 0 ? (
          <p className="text-ash">Nothing beyond its own tools.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4 text-ash">
            {uses.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        )}
        {uses.length > 0 && <p className="mt-1 text-[11px] text-slate">Each is asked about once, the first time the app uses it.</p>}
      </Section>

      <Section title="Secrets it wants" testId="review-secrets">
        {review.secrets.length === 0 ? (
          <p className="text-ash">None.</p>
        ) : (
          <p className="text-ash">
            <span className="font-mono text-[11px] text-chalk">{review.secrets.join(', ')}</span>
            <span className="text-slate"> — you enter the values after it is in, and they stay on this machine.</span>
          </p>
        )}
      </Section>

      <Section title="Screen" testId="review-screen">
        <p className="text-ash">
          {review.home ? `Opens with its "${review.home}" tool, in a sandboxed frame` : 'No screen: tools for agents only'}
          {review.home && review.viewOrigin === 'app' ? ', with its own browser storage (it asked for that)' : ''}.
        </p>
      </Section>

      <Section title={`Files · ${review.files.length} · ${size(review.totalBytes)}`} testId="review-files">
        <ul className="max-h-40 overflow-y-auto rounded border border-edge bg-void px-2 py-1 font-mono text-[11px]" data-testid="review-file-list">
          {review.files.map((f) => (
            <li key={f.path} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate text-ash" title={f.path}>
                {f.path}
              </span>
              <span className="shrink-0 text-slate">{size(f.bytes)}</span>
            </li>
          ))}
        </ul>
        {review.skipped.length > 0 && (
          <p className="mt-1 break-words text-[11px] leading-relaxed text-slate" data-testid="review-skipped">
            Not copied: {review.skipped.map((s) => `${s.path} (${SKIP_WHY[s.why] ?? s.why})`).join(', ')}
          </p>
        )}
      </Section>

      {review.warnings.length > 0 && (
        <Section title="Warnings" testId="review-warnings">
          <ul className="list-disc pl-4 text-ash">
            {review.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

const SKIP_WHY: Record<string, string> = {
  hidden: 'hidden',
  link: 'a link, not followed',
  'link to nothing': 'a broken link',
  'not a regular file': 'not a regular file',
}

function Section({ title, testId, tone, children }: { title: string; testId: string; tone?: 'alert'; children: React.ReactNode }) {
  return (
    <section data-testid={testId} className={tone === 'alert' ? 'rounded border border-edge bg-panel px-2.5 py-2' : undefined}>
      <p className={`readout mb-1 text-[10px] uppercase ${tone === 'alert' ? 'text-chalk' : 'text-slate'}`}>{title}</p>
      {children}
    </section>
  )
}

/** 명령과 인자를 한 줄로 — 인자는 칸마다 따로 보인다(빈칸이 든 인자가 두 인자로 읽히지 않게) */
function Command({ server, testId = 'review-command' }: { server: AppReview['server']; testId?: string }) {
  return (
    <code className="block break-all rounded border border-edge bg-void px-2 py-1 font-mono text-[11px] text-chalk" data-testid={testId}>
      {[server.command, ...server.args].map((part, i) => (
        <span key={i}>
          {i > 0 ? ' ' : ''}
          {/\s/.test(part) || part === '' ? JSON.stringify(part) : part}
        </span>
      ))}
    </code>
  )
}

/** `uses`를 사람의 말로 — 한 능력에 한 줄 */
export function usesLines(uses: AppUses): string[] {
  const out: string[] = []
  if (uses.agent === true) out.push('Run your default agent in a new session')
  else if (Array.isArray(uses.agent) && uses.agent.length) out.push(`Run your agent in a new session: ${uses.agent.join(', ')}`)
  if (uses.apps?.length) out.push(`Call other apps: ${uses.apps.join(', ')}`)
  if (uses.host?.length) out.push(`Read Centralu data: ${uses.host.join(', ')}`)
  return out
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
