import { randomUUID } from 'node:crypto'
import type { InputObserver } from './contract.js'

export type InputReceipt = { id: ReturnType<typeof randomUUID>; done: Promise<void>; cancelled: boolean; completed: boolean }

/** Tracks completion of input, rather than its acceptance by a CLI. Vendor correlation stays in the adapter. */
export class InputReceipts {
  private pending = new Map<string, { receipt: InputReceipt; resolve(): void; reject(e: Error): void; turn?: string; observer?: InputObserver }>()
  private ended = new Set<string>()

  create(observer?: InputObserver): InputReceipt {
    const id = randomUUID()
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

  /** Codex's turn/start response can arrive after that turn's completion notification. */
  bind(receipt: InputReceipt, turn: string): void {
    const p = this.pending.get(receipt.id)
    if (!p) return
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
    p.receipt.completed = true
    p.observer?.complete()
    p.resolve()
  }
}
