import { randomUUID } from 'node:crypto'
import type { InputObserver } from './contract.js'

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** An id the host named an input by (#1377): the tools take only a UUID */
export function isUuid(s: string): s is ReturnType<typeof randomUUID> {
  return UUID_FORMAT.test(s)
}

export type InputReceipt = { id: ReturnType<typeof randomUUID>; done: Promise<void>; cancelled: boolean; completed: boolean }

/** Tracks completion of input, rather than its acceptance by a CLI. Vendor correlation stays in the adapter. */
export class InputReceipts {
  private pending = new Map<string, { receipt: InputReceipt; resolve(): void; reject(e: Error): void; turn?: string; observer?: InputObserver; accepted?: true }>()
  private ended = new Set<string>()

  /** `named`: the id the caller gave the input, which the tool then names back; none, one is made */
  create(observer?: InputObserver, named?: ReturnType<typeof randomUUID>): InputReceipt {
    const id = named ?? randomUUID()
    let resolve!: () => void
    let reject!: (e: Error) => void
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    done.catch(() => {})
    const receipt = { id, done, cancelled: false, completed: false }
    this.pending.set(id, { receipt, resolve, reject, observer })
    return receipt
  }

  get size(): number { return this.pending.size }
  get ids(): string[] { return [...this.pending.keys()] }

  /** The tool took the input (once): the observer is told before the turn is recorded */
  accept(id: string): void {
    const p = this.pending.get(id)
    if (!p || p.accepted) return
    p.accepted = true
    p.observer?.accepted?.()
  }

  /** Codex's turn/start response can arrive after that turn's completion notification. */
  bind(receipt: InputReceipt, turn: string): void {
    const p = this.pending.get(receipt.id)
    if (!p) return
    // `turn/start` answered with the turn: the input is taken
    this.accept(receipt.id)
    p.turn = turn
    if (this.ended.has(turn)) this.finish(receipt.id)
  }

  endTurn(turn: string): void {
    if (this.pending.size) this.ended.add(turn)
    for (const [id, p] of this.pending) if (p.turn === turn) this.finish(id)
  }

  /** Retries can reorder inputs; only UUIDs actually reported as consumed have completed. */
  complete(ids: readonly string[]): void {
    for (const id of ids) this.finish(id)
  }

  failAll(error: Error): string[] {
    const turns = [...new Set([...this.pending.values()].flatMap((p) => p.turn ? [p.turn] : []))]
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.ended.clear()
    for (const p of pending) { p.receipt.cancelled = true; p.observer?.fail(error); p.reject(error) }
    return turns
  }

  private finish(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (!this.pending.size) this.ended.clear()
    if (!p.accepted) p.observer?.accepted?.()
    p.receipt.completed = true
    p.observer?.complete()
    p.resolve()
  }
}
