import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_PREVIEW_MAX_BYTES, type ApprovalDecision, type MessageImage, type NormalizedEvent, type ProjectInfo, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { itSymlink } from '../link.test-helpers.js'

/**
 * `messages.image` through the RPC handler and a real store: an image a reply names is read wherever it is, and every
 * other path is refused for its own reason. The file checks alone are in dev-services/message-image.test.ts.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

class ScriptHandle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string, private emit: EventSink) {}
  send() {}
  /** The agent says `text`; `done` closes the reply as a turn's end does */
  say(text: string, done = true) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    if (done) this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  raw(e: NormalizedEvent) {
    this.emit(e)
  }
  respondApproval(_requestId: string, _decision: ApprovalDecision): boolean {
    return true
  }
  interrupt() {}
  async dispose() {}
}

class ScriptAdapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  readonly descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities = {
    approvals: true, contextUsage: 'exact' as const, resume: true, autoTitle: true, attachments: [],
    verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  handles = new Map<string, ScriptHandle>()
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'script' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new ScriptHandle(opts.sessionId, emit)
    this.handles.set(opts.sessionId, h)
    return h
  }
}

let root = ''
let elsewhere = ''
let adapter: ScriptAdapter
let rpc: ReturnType<typeof createRpcHandler>
let project: ProjectInfo
let session: SessionInfo

beforeEach(async () => {
  // native: the host answers with the expanded path, and Windows' temp folder can be an 8.3 short name (RUNNER~1)
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-reply-image-')))
  // Outside the project: a reply's image may be anywhere on the machine
  elsewhere = join(root, 'elsewhere')
  mkdirSync(join(root, 'project', 'out'), { recursive: true })
  mkdirSync(elsewhere)
  adapter = new ScriptAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  rpc = createRpcHandler(new SessionManager(new Store(), adapters, () => {}), adapters)
  project = (await rpc('projects.add', { path: join(root, 'project') })) as ProjectInfo
  session = (await rpc('agents.createSession', { projectId: project.id, cwd: project.path, tool: 'claude' })) as SessionInfo
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const agent = () => adapter.handles.get(session.id)!
const image = (path: string, sessionId = session.id) => rpc('messages.image', { sessionId, path }) as Promise<MessageImage>

describe('an image a reply names', () => {
  it('is read from outside the project, and comes back with its type and bytes', async () => {
    const file = join(elsewhere, 'grid.png')
    writeFileSync(file, PNG)
    agent().say(`The comparison:\n\n![Origin comparison](${file})`)
    expect(await image(file)).toEqual({ ok: true, mime: 'image/png', data: PNG.toString('base64'), file })
  })

  it('is read relative to the session folder, from a file URL, and while the reply is still streaming', async () => {
    writeFileSync(join(project.path, 'out', 'a.png'), PNG)
    const url = pathToFileURL(join(elsewhere, 'b c.png')).href
    writeFileSync(join(elsewhere, 'b c.png'), PNG)
    agent().say(`![a](out/a.png) and ![b](${url})`)
    expect(await image('out/a.png')).toMatchObject({ ok: true, file: join(project.path, 'out', 'a.png') })
    // The window sends a destination decoded; the reply holds the URL's own %20
    expect(await image(decodeURIComponent(url))).toMatchObject({ ok: true, file: join(elsewhere, 'b c.png') })

    // The first chunk of a reply is written at once; a later one lives in memory until the next flush
    writeFileSync(join(elsewhere, 'live.png'), PNG)
    agent().say('Still going… ', false)
    agent().say(`![live](${join(elsewhere, 'live.png')})`, false)
    expect(await image(join(elsewhere, 'live.png'))).toMatchObject({ ok: true })
  })

  it("is read from a subagent's reply, which the window shows under its card", async () => {
    const file = join(elsewhere, 'sub.png')
    writeFileSync(file, PNG)
    agent().raw({
      type: 'subagent_event',
      sessionId: session.id,
      parentCallId: 'task-1',
      step: { type: 'message_delta', sessionId: session.id, role: 'assistant', text: `![sub](${file})` },
    } as NormalizedEvent)
    expect(await image(file)).toMatchObject({ ok: true })
  })
})

describe('a local file link a reply names (messages.resolveFile)', () => {
  const resolveFile = (path: string, sessionId = session.id) =>
    rpc('messages.resolveFile', { sessionId, path }) as Promise<{ ok: boolean; file?: string; reason?: string; message?: string }>

  it('resolves non-image files, Korean names, folders, #L/:line links, encoded # file:// URLs, streaming, and subagent replies', async () => {
    const dir = join(elsewhere, '자동사냥-배속-배너')
    mkdirSync(dir, { recursive: true })
    const zip = join(dir, '상점용-PNG.zip')
    const txt = join(dir, 'notes.txt')
    const hashFile = join(dir, 'report #1.pdf')
    const shot = join(dir, 'shot.png')
    writeFileSync(zip, 'PK\x03\x04')
    writeFileSync(txt, 'hello')
    writeFileSync(hashFile, '%PDF')
    writeFileSync(shot, PNG)
    const fileUrl = `${pathToFileURL(txt).href}#L10-L20`
    const fileColonUrl = `${pathToFileURL(txt).href}:12`
    const hashFileUrl = pathToFileURL(hashFile).href
    agent().say(
      `[다운로드](${zip}) · [메모](${fileUrl}) · [URL라인](${fileColonUrl}) · [앵커](${txt}#L10-L20) · [라인](${txt}:12:4) · [폴더](${dir}) · [해시](${hashFileUrl}) · [이미지](${shot}:1)`,
    )

    expect(await resolveFile(zip)).toEqual({ ok: true, file: zip })
    expect(await resolveFile(fileUrl)).toEqual({ ok: true, file: txt })
    expect(await resolveFile(fileColonUrl)).toEqual({ ok: true, file: txt })
    expect(await resolveFile(`${txt}#L10-L20`)).toEqual({ ok: true, file: txt })
    expect(await resolveFile(`${txt}:12:4`)).toEqual({ ok: true, file: txt })
    expect(await resolveFile(dir)).toEqual({ ok: true, file: dir })
    // Raw file:// URL keeps %23 intact so fileURLToPath resolves `report #1.pdf` instead of truncating at `#`
    expect(await resolveFile(hashFileUrl)).toEqual({ ok: true, file: hashFile })
    // Image links with :1 suffix fall back cleanly in messages.image as well
    expect(await image(`${shot}:1`)).toMatchObject({ ok: true, file: shot })

    // Streaming reply in memory
    const liveFile = join(elsewhere, 'live.zip')
    writeFileSync(liveFile, 'PK')
    agent().say('Streaming… ', false)
    agent().say(`[live](${liveFile})`, false)
    expect(await resolveFile(liveFile)).toEqual({ ok: true, file: liveFile })

    // Subagent reply
    const subFile = join(elsewhere, 'sub.zip')
    writeFileSync(subFile, 'PK')
    agent().raw({
      type: 'subagent_event',
      sessionId: session.id,
      parentCallId: 'task-2',
      step: { type: 'message_delta', sessionId: session.id, role: 'assistant', text: `[sub](${subFile})` },
    })
    expect(await resolveFile(subFile)).toEqual({ ok: true, file: subFile })
  })

  it('refuses unmentioned paths, missing files, off-machine file:// URLs, and filesystem roots', async () => {
    const secret = join(elsewhere, 'secret.zip')
    writeFileSync(secret, 'x')
    const missing = join(elsewhere, 'missing.zip')
    agent().say(`[missing](${missing}) · [remote](file://server/share/a.zip) · [root](/)`)

    expect(await resolveFile(secret)).toMatchObject({ ok: false, reason: 'not_mentioned' })
    expect(await resolveFile(missing)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await resolveFile('file://server/share/a.zip')).toMatchObject({ ok: false, reason: 'not_found' })
    if (process.platform !== 'win32') {
      expect(await resolveFile('/')).toMatchObject({ ok: false, reason: 'unreadable' })
    }
  })
})

describe('a path no reply of this session names', () => {
  it('is refused before it is read, even when it is a real image', async () => {
    const file = join(elsewhere, 'grid.png')
    writeFileSync(file, PNG)
    agent().say('Nothing to show.')
    const got = await image(file)
    expect(got).toMatchObject({ ok: false, reason: 'not_mentioned' })
    // Nothing about the file: not its bytes, not where it resolves
    expect(got).not.toHaveProperty('file')
  })

  it("is refused when only the person's message names it, or another session's reply", async () => {
    const file = join(elsewhere, 'grid.png')
    writeFileSync(file, PNG)
    await rpc('agents.send', { sessionId: session.id, text: `look at ![x](${file})` })
    expect(await image(file)).toMatchObject({ ok: false, reason: 'not_mentioned' })

    const other = (await rpc('agents.createSession', { projectId: project.id, cwd: project.path, tool: 'claude' })) as SessionInfo
    adapter.handles.get(other.id)!.say(`![x](${file})`)
    expect(await image(file, other.id)).toMatchObject({ ok: true })
    expect(await image(file)).toMatchObject({ ok: false, reason: 'not_mentioned' })
  })

  it('is refused when it is only the tail of a longer path the reply wrote', async () => {
    writeFileSync(join(project.path, 'grid.png'), PNG)
    agent().say(`![x](${join(elsewhere, 'grid.png')})`)
    expect(await image('grid.png')).toMatchObject({ ok: false, reason: 'not_mentioned' })
  })
})

describe('a path a reply names that is not an image to show', () => {
  itSymlink('is refused as not an image by its bytes, and a link to text as well, without its contents', async () => {
    writeFileSync(join(elsewhere, 'notes.png'), 'password=hunter2')
    symlinkSync(join(elsewhere, 'notes.png'), join(elsewhere, 'link.png'))
    agent().say(`![a](${join(elsewhere, 'notes.png')}) ![b](${join(elsewhere, 'link.png')})`)
    for (const path of [join(elsewhere, 'notes.png'), join(elsewhere, 'link.png')]) {
      const got = await image(path)
      expect(got).toMatchObject({ ok: false, reason: 'not_an_image', file: join(elsewhere, 'notes.png') })
      expect(JSON.stringify(got)).not.toContain('hunter2')
    }
  })

  it('is refused as too large past 10 MB', async () => {
    const big = Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1)
    PNG.copy(big)
    writeFileSync(join(elsewhere, 'big.png'), big)
    agent().say(`![big](${join(elsewhere, 'big.png')})`)
    expect(await image(join(elsewhere, 'big.png'))).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('is refused as not found when nothing is there', async () => {
    agent().say(`![gone](${join(elsewhere, 'gone.png')})`)
    expect(await image(join(elsewhere, 'gone.png'))).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

it('refuses an unknown session as an error, and a path that is empty or absurdly long at the boundary', async () => {
  await expect(image('/x.png', 'sess-nope')).rejects.toThrow(/Session not found/)
  await expect(image('')).rejects.toThrow()
  await expect(image(`/${'a'.repeat(5000)}.png`)).rejects.toThrow()
})
