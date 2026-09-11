import type { NormalizedEvent, StoredMessage } from '@cc/protocol'

export interface MessageJournalStore {
  nextSeq(sessionId: string): number
  upsertMessageNoIndex(message: StoredMessage): void
  appendMessages(messages: StoredMessage[]): void
}

const STREAM_FLUSH_CHARS = 2000
const STREAM_FLUSH_MS = 2000

type StreamKind = 'text' | 'reasoning'
type StreamRun = {
  seq: number
  kind: StreamKind
  payload: Record<string, unknown>
  text: string
  written: number
  lastWrite: number
}

/** One row per text/reasoning run. Delta-driven checkpoints defer FTS until a boundary. */
export class MessageJournal {
  private streams = new Map<string, StreamRun>()

  constructor(private readonly store: MessageJournalStore, private readonly now = () => Date.now()) {}

  persist(e: NormalizedEvent, sessionId: string): number | null {
    const streamKind = streamKindOf(e)
    if (streamKind) return this.persistStream(e, sessionId, streamKind)

    const kind = messageKindOf(e)
    const boundary =
      kind !== null ||
      e.type === 'turn_complete' ||
      e.type === 'error' ||
      (e.type === 'state_change' && e.state !== 'working')
    if (boundary) this.close(sessionId)
    if (!kind) return null

    const seq = this.store.nextSeq(sessionId)
    this.store.appendMessages([{ sessionId, seq, role: 'system', kind, payload: e, ts: this.now() }])
    return seq
  }

  close(sessionId: string): void {
    const run = this.streams.get(sessionId)
    if (!run) return
    this.streams.delete(sessionId)
    this.store.appendMessages([this.messageFromRun(sessionId, run)])
  }

  discard(sessionId: string): void {
    this.streams.delete(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.streams.keys()]) this.close(id)
  }

  private persistStream(e: NormalizedEvent, sessionId: string, kind: StreamKind): number | null {
    const text = e.type === 'message_delta' || e.type === 'reasoning_delta' ? (e.text ?? '') : ''
    const run = this.streams.get(sessionId)
    if (run && run.kind === kind) {
      run.text += text
      if (run.text.length - run.written >= STREAM_FLUSH_CHARS || this.now() - run.lastWrite >= STREAM_FLUSH_MS) {
        this.flush(sessionId, run)
      }
      return run.seq
    }

    if (run) this.close(sessionId)
    if (!text) return null

    const fresh: StreamRun = {
      seq: this.store.nextSeq(sessionId),
      kind,
      payload: { ...e },
      text,
      written: 0,
      lastWrite: 0,
    }
    this.streams.set(sessionId, fresh)
    this.flush(sessionId, fresh)
    return fresh.seq
  }

  private flush(sessionId: string, run: StreamRun): void {
    this.store.upsertMessageNoIndex(this.messageFromRun(sessionId, run))
    run.written = run.text.length
    run.lastWrite = this.now()
  }

  private messageFromRun(sessionId: string, run: StreamRun): StoredMessage {
    return {
      sessionId,
      seq: run.seq,
      role: 'assistant',
      kind: run.kind,
      payload: { ...run.payload, text: run.text },
      ts: this.now(),
    }
  }
}

function streamKindOf(e: NormalizedEvent): StreamKind | null {
  if (e.type === 'message_delta') return 'text'
  if (e.type === 'reasoning_delta' && e.text) return 'reasoning'
  return null
}

function messageKindOf(e: NormalizedEvent): StoredMessage['kind'] | null {
  if (e.type === 'tool_call') return 'tool_call'
  if (e.type === 'tool_result') return 'tool_result'
  if (e.type === 'approval_request' || e.type === 'approval_resolved') return 'approval'
  if (e.type === 'compaction') return 'marker'
  return null
}
