import type { AppReview, AppUses } from '@cc/protocol'

/**
 * What the person sees before enabling something (M4 E-3) — what the app being imported (or the
 * already-imported app that needs re-confirmation) **runs**, **what it will use**, what secrets
 * it wants, and which files are coming in. The import dialog and the pinned-view confirmation
 * share this one component.
 *
 * The order is the priority. The command stands at the top: an app server is code that runs on
 * this machine with the person's own permissions (the sandbox only applies to the screen), so
 * enabling it means agreeing to run this command. If this is a re-confirmation, what changed
 * stands even before that — that is the whole reason it is asking again.
 */
export function AppReviewDetails({ review }: { review: AppReview }) {
  const uses = usesLines(review.uses)
  return (
    <div className="space-y-3 text-[12px]" data-testid="app-review">
      <div>
        <p className="text-[13px] text-ink">
          <span data-testid="review-name">{review.name}</span> <span className="readout text-[10px] text-ink-faint">v{review.version}</span>{' '}
          <span className="readout text-[10px] text-ink-faint">{review.appId}</span>
        </p>
        <p className="mt-0.5 break-words text-[11px] text-ink-faint" data-testid="review-source">
          From {review.source}
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-ink-muted">{review.description}</p>
      </div>

      {review.changed && (
        <Section title="Changed since you enabled it" testId="review-changed" tone="alert">
          {review.changed.server && (
            <p className="text-ink-muted">
              It used to run <Command server={review.changed.was.server} testId="review-command-was" />
            </p>
          )}
          {review.changed.uses && (
            <p className="text-ink-muted">
              It used to ask for:{' '}
              {usesLines(review.changed.was.uses).join('; ') || 'nothing beyond its own tools'}
            </p>
          )}
        </Section>
      )}

      <Section title="What it runs" testId="review-runs">
        <Command server={review.server} />
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          In its own folder, as you: it can read your files, use the network and start programs. Only its screen is sandboxed.
        </p>
      </Section>

      <Section title="What it asks Centralu for" testId="review-uses">
        {uses.length === 0 ? (
          <p className="text-ink-muted">Nothing beyond its own tools.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4 text-ink-muted">
            {uses.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        )}
        {uses.length > 0 && <p className="mt-1 text-[11px] text-ink-faint">Each is asked about once, the first time the app uses it.</p>}
      </Section>

      <Section title="Secrets it wants" testId="review-secrets">
        {review.secrets.length === 0 ? (
          <p className="text-ink-muted">None.</p>
        ) : (
          <p className="text-ink-muted">
            <span className="font-mono text-[11px] text-ink">{review.secrets.join(', ')}</span>
            <span className="text-ink-faint"> — you enter the values after it is in, and they stay on this machine.</span>
          </p>
        )}
      </Section>

      <Section title="Screen" testId="review-screen">
        <p className="text-ink-muted">
          {review.home ? `Opens with its "${review.home}" tool, in a sandboxed frame` : 'No screen: tools for agents only'}
          {review.home && review.viewOrigin === 'app' ? ', with its own browser storage (it asked for that)' : ''}.
        </p>
      </Section>

      <Section title={`Files · ${review.files.length} · ${size(review.totalBytes)}`} testId="review-files">
        <ul className="max-h-40 overflow-y-auto rounded border border-line bg-surface-floor px-2 py-1 font-mono text-[11px]" data-testid="review-file-list">
          {review.files.map((f) => (
            <li key={f.path} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate text-ink-muted" title={f.path}>
                {f.path}
              </span>
              <span className="shrink-0 text-ink-faint">{size(f.bytes)}</span>
            </li>
          ))}
        </ul>
        {review.skipped.length > 0 && (
          <p className="mt-1 break-words text-[11px] leading-relaxed text-ink-faint" data-testid="review-skipped">
            Not copied: {review.skipped.map((s) => `${s.path} (${SKIP_WHY[s.why] ?? s.why})`).join(', ')}
          </p>
        )}
      </Section>

      {review.warnings.length > 0 && (
        <Section title="Warnings" testId="review-warnings">
          <ul className="list-disc pl-4 text-ink-muted">
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
    <section data-testid={testId} className={tone === 'alert' ? 'rounded border border-line bg-surface-raised px-2.5 py-2' : undefined}>
      <p className={`readout mb-1 text-[10px] uppercase ${tone === 'alert' ? 'text-ink' : 'text-ink-faint'}`}>{title}</p>
      {children}
    </section>
  )
}

/** The command and its arguments on one line — each argument shown in its own span (so an argument containing a space is not read as two arguments) */
function Command({ server, testId = 'review-command' }: { server: AppReview['server']; testId?: string }) {
  return (
    <code className="block break-all rounded border border-line bg-surface-floor px-2 py-1 font-mono text-[11px] text-ink" data-testid={testId}>
      {[server.command, ...server.args].map((part, i) => (
        <span key={i}>
          {i > 0 ? ' ' : ''}
          {/\s/.test(part) || part === '' ? JSON.stringify(part) : part}
        </span>
      ))}
    </code>
  )
}

/** `uses` in plain words — one line per capability */
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
