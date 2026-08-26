import { describe, expect, it, vi } from 'vitest'
import { CommandRunner } from './commands.js'

/**
 * 자주 쓰는 명령어 실행기 (#60)의 계약:
 *   - 명령별 마지막 실행 하나 (재실행 = 죽이고 새로, 로그 교체)
 *   - 서로 다른 명령은 동시 실행
 *   - 끝나면 종료 코드와 함께 로그가 남는다 (단발/상주 구분 없음)
 */

function fakePty() {
  const instances: {
    kill: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    emitData: (d: string) => void
    emitExit: (code: number) => void
  }[] = []
  const mod = {
    spawn(_file: string, args: string[], _opts: Record<string, unknown>) {
      let onData = (_d: string) => {}
      let onExit = (_e: { exitCode: number }) => {}
      const inst = {
        args,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        emitData: (d: string) => onData(d),
        emitExit: (code: number) => onExit({ exitCode: code }),
        onData: (cb: (d: string) => void) => (onData = cb),
        onExit: (cb: (e: { exitCode: number }) => void) => (onExit = cb),
      }
      instances.push(inst)
      return inst
    },
  }
  return { mod, instances }
}

function stub(svc: CommandRunner, mod: unknown): void {
  ;(svc as unknown as { loadPty: () => unknown }).loadPty = () => mod
}

describe('CommandRunner', () => {
  it('출력이 로그에 쌓이고, 끝나면 종료 코드가 남는다', () => {
    const fake = fakePty()
    const frames: unknown[] = []
    const svc = new CommandRunner((f) => frames.push(f))
    stub(svc, fake.mod)

    const r = svc.run('/tmp/p', 'pnpm test')
    fake.instances[0]!.emitData('오류 0건\r\n')
    fake.instances[0]!.emitExit(0)

    const log = svc.log('/tmp/p', 'pnpm test')!
    expect(log.history).toBe('오류 0건\r\n')
    expect(log.running).toBe(false)
    expect(log.exitCode).toBe(0)
    expect(frames).toContainEqual({ terminalId: r.runId, data: '오류 0건\r\n' })
    expect(frames).toContainEqual({ terminalId: r.runId, exitCode: 0 })
  })

  it('재실행은 죽이고 새로 시작하며 로그를 교체한다 — runId도 새것', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)

    const r1 = svc.run('/tmp/p', 'pnpm dev')
    fake.instances[0]!.emitData('옛 로그')
    const r2 = svc.run('/tmp/p', 'pnpm dev')

    expect(fake.instances[0]!.kill).toHaveBeenCalled()
    expect(r2.runId).not.toBe(r1.runId)
    expect(svc.log('/tmp/p', 'pnpm dev')!.history).toBe('')
    // 죽어가는 옛 프로세스의 마지막 출력은 새 로그에 섞이지 않는다
    fake.instances[0]!.emitData('유령 출력')
    expect(svc.log('/tmp/p', 'pnpm dev')!.history).toBe('')
  })

  it('서로 다른 명령은 동시에 돈다 — 명령당 프로세스 하나', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)

    svc.run('/tmp/p', 'pnpm dev')
    svc.run('/tmp/p', 'pnpm test')
    expect(fake.instances).toHaveLength(2)
    expect(fake.instances[0]!.kill).not.toHaveBeenCalled()

    const state = svc.state('/tmp/p')
    expect(state.map((s) => s.command).sort()).toEqual(['pnpm dev', 'pnpm test'])
    expect(state.every((s) => s.running)).toBe(true)
  })

  it('stop은 프로세스만 죽인다 — 로그는 남는다 (종료도 결과다)', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)

    svc.run('/tmp/p', 'pnpm dev')
    fake.instances[0]!.emitData('서버 뜸\r\n')
    svc.stop('/tmp/p', 'pnpm dev')
    fake.instances[0]!.emitExit(130)

    const log = svc.log('/tmp/p', 'pnpm dev')!
    expect(log.running).toBe(false)
    expect(log.history).toBe('서버 뜸\r\n')
    expect(log.exitCode).toBe(130)
  })

  it('실행된 적 없는 명령의 로그는 null — 빈 로그와 구분된다', () => {
    const svc = new CommandRunner(() => {})
    stub(svc, fakePty().mod)
    expect(svc.log('/tmp/p', 'pnpm build')).toBeNull()
  })

  it('디렉토리가 다르면 같은 명령도 별개다 (워크트리 준비 — 터미널과 같은 규칙)', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)
    svc.run('/tmp/a', 'pnpm dev')
    svc.run('/tmp/b', 'pnpm dev')
    expect(fake.instances).toHaveLength(2)
    expect(svc.state('/tmp/a')).toHaveLength(1)
  })
})
