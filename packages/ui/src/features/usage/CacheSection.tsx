import { useState, type ReactNode } from 'react'
import type { CacheSessionStats, CacheStats, CacheWindowStats } from '@cc/protocol'
import { cacheHitRate, cacheWindowName, percentOf } from '@cc/core'
import { Tooltip } from '../../components/primitives.jsx'
import { formatTokens } from './format.js'

/**
 * The prompt cache, in the usage dropdown (docs/agent-host.md §6.1).
 *
 * A rebuild (a request that wrote its prompt to the cache again) is what costs: it is paid at the write price and
 * counts toward the limit the donut above shows. So the section answers three questions in reading order: how much
 * came from the cache (the hit rate), what the input was made of (read, written, uncached), and where the writes came
 * from (the sessions that wrote most, each one click from being opened).
 *
 * Two windows, the last five hours (the tooltip's) and today, behind one switch rather than side by side: the
 * dropdown is 420px wide, and two columns of six figures would be read as a table to compare, which they are not.
 */
export function CacheSection({
  cache,
  toolLabel,
  canOpen,
  onOpen,
}: {
  cache: CacheStats
  /** "Claude Code", "Codex": named in the note that the tool reports reads only */
  toolLabel: string
  /** Whether a session is on this screen to be opened (a deleted one, or one of a machine that went away, is not) */
  canOpen: (sessionId: string) => boolean
  onOpen: (sessionId: string) => void
}) {
  const [picked, setPicked] = useState(0)
  const w = cache.windows[picked] ?? cache.windows[0]
  if (!w) return null
  const name = cacheWindowName(w, cache.countingSince)
  const rate = cacheHitRate(w)

  return (
    <section className="mt-5 border-t border-line pt-3" data-testid="usage-cache" data-window={w.id}>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase text-ink-faint">Prompt cache</span>
        {cache.windows.length > 1 && (
          <span className="ml-auto flex rounded-md border border-line p-px" role="group" aria-label="Cache window">
            {cache.windows.map((x, i) => (
              <button
                key={x.id}
                type="button"
                aria-pressed={x === w}
                onClick={() => setPicked(i)}
                data-testid={`usage-cache-window-${x.id}`}
                className={`rounded px-1.5 text-2xs leading-body ${
                  x === w ? 'bg-surface-hover text-ink' : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                {shortName(x)}
              </button>
            ))}
          </span>
        )}
      </div>

      {rate === null ? (
        <p className="mt-2 text-xs text-ink-muted" data-testid="usage-cache-empty">
          No model requests {name.startsWith('since') ? name : `in the ${name}`}
        </p>
      ) : (
        <>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="readout text-md text-ink" data-testid="usage-cache-rate">
              {percentOf(rate)}%
            </span>
            <span className="text-xs text-ink-muted">
              cache hit · {name}
            </span>
          </p>
          <InputBar w={w} writes={cache.writes} />
          <dl className="mt-2 space-y-0.5 text-xs" data-testid="usage-cache-figures">
            <Figure swatch="bg-ink-muted" label="Read from cache" value={formatTokens(w.cacheReadTokens)} testId="read" />
            <Figure
              // No mark for a figure that is not there: the bar has no such part either
              swatch={cache.writes ? 'bg-ink' : undefined}
              label="Written to cache"
              value={cache.writes ? formatTokens(w.cacheCreationTokens) : 'not reported'}
              testId="written"
            />
            <Figure swatch="bg-ink-faint" label="Uncached input" value={formatTokens(w.inputTokens)} testId="uncached" />
            {cache.writes && (
              <Figure
                label={
                  <Tooltip
                    testId="usage-cache-rebuild-tip"
                    content={
                      <span className="block max-w-[260px] text-ink-muted">
                        A request that wrote at least half its input to the cache (4k tokens or more): its cached prompt
                        had expired or changed, so it was paid again at the write price
                      </span>
                    }
                  >
                    <span className="underline decoration-dotted decoration-ink-faint underline-offset-2">Rebuilds</span>
                  </Tooltip>
                }
                value={`${w.rebuilds} of ${w.requests} requests`}
                testId="rebuilds"
              />
            )}
          </dl>
          {!cache.writes && (
            <p className="mt-2 text-2xs leading-body text-ink-faint" data-testid="usage-cache-reads-only">
              {toolLabel} reports cache reads only, not writes: the hit rate is cached input over all input.
            </p>
          )}
          {w.sessions.length > 0 && (
            <TopSessions sessions={w.sessions} writes={cache.writes} canOpen={canOpen} onOpen={onOpen} />
          )}
        </>
      )}
      {Date.parse(cache.countingSince) > Date.parse(w.since) && (
        <p className="mt-2 text-2xs text-ink-faint" data-testid="usage-cache-since">
          Counted by the host since it started; earlier requests are not known.
        </p>
      )}
    </section>
  )
}

/** "5 h", "Today": the switch's words, shorter than the window's own name */
function shortName(w: CacheWindowStats): string {
  if (w.id === '5h') return '5 h'
  return w.label.charAt(0).toUpperCase() + w.label.slice(1)
}

/**
 * What the input was made of, as one bar. Brightness, not hue (the screen's rule): writes are the brightest because
 * they are the cost, reads the middle, uncached input the faintest. The legend is the figures below it, each with its
 * swatch, so no part is told apart by tone alone.
 */
function InputBar({ w, writes }: { w: CacheWindowStats; writes: boolean }) {
  const total = w.inputTokens + w.cacheReadTokens + w.cacheCreationTokens
  const parts = [
    { tone: 'bg-ink-muted', n: w.cacheReadTokens, what: 'read from cache' },
    ...(writes ? [{ tone: 'bg-ink', n: w.cacheCreationTokens, what: 'written to cache' }] : []),
    { tone: 'bg-ink-faint', n: w.inputTokens, what: 'uncached' },
  ].filter((p) => p.n > 0)
  return (
    <span className="mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden data-testid="usage-cache-bar">
      {parts.map((p) => (
        <span
          key={p.what}
          className={`block h-full min-w-0.5 ${p.tone}`}
          style={{ flexGrow: p.n / total, flexBasis: 0 }}
          title={`${formatTokens(p.n)} ${p.what}`}
        />
      ))}
    </span>
  )
}

function Figure({
  swatch,
  label,
  value,
  testId,
}: {
  swatch?: string
  label: ReactNode
  value: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-2" data-testid={`usage-cache-${testId}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${swatch ?? ''}`} aria-hidden />
      <dt className="text-ink-muted">{label}</dt>
      <dd className="readout ml-auto text-ink">{value}</dd>
    </div>
  )
}

/**
 * The sessions that cost the cache most: by what they wrote, or for a tool that reports reads only, by the input that
 * did not come from the cache. A row opens its session; one that is not on this screen is plain text.
 */
function TopSessions({
  sessions,
  writes,
  canOpen,
  onOpen,
}: {
  sessions: CacheSessionStats[]
  writes: boolean
  canOpen: (sessionId: string) => boolean
  onOpen: (sessionId: string) => void
}) {
  return (
    <div className="mt-3" data-testid="usage-cache-sessions">
      <span className="text-2xs uppercase text-ink-faint">{writes ? 'Most cache writes' : 'Most uncached input'}</span>
      <ul className="mt-1 space-y-px">
        {sessions.map((s) => {
          const title = s.name || 'Deleted session'
          const figure = writes
            ? `${formatTokens(s.cacheCreationTokens)}${s.rebuilds ? ` · ${s.rebuilds} rebuild${s.rebuilds === 1 ? '' : 's'}` : ''}`
            : formatTokens(s.inputTokens)
          const body = (
            <>
              <span className="truncate">{title}</span>
              <span className="readout ml-auto shrink-0 text-ink-faint">{figure}</span>
            </>
          )
          return (
            <li key={s.sessionId}>
              {canOpen(s.sessionId) ? (
                <button
                  type="button"
                  onClick={() => onOpen(s.sessionId)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                  data-testid={`usage-cache-session-${s.sessionId}`}
                >
                  {body}
                </button>
              ) : (
                <span
                  className="flex items-center gap-2 px-1 py-0.5 text-xs text-ink-faint"
                  data-testid={`usage-cache-session-${s.sessionId}`}
                >
                  {body}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
