import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { expandGlob, isConcreteAlias, listSshHosts, MAX_HOSTS, parseSshG, readSshConfig, resolveAlias, splitConfigLine, type ResolvedHost } from './ssh-config.js'

/**
 * The ssh config the Add machine dialog lists (#514): read the way OpenSSH reads it, in a temporary
 * home folder (never the person's ~/.ssh), and resolved through a fake `ssh -G` that logs what it was
 * asked.
 */

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-sshcfg-'))
  mkdirSync(join(home, '.ssh'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const write = (rel: string, text: string) => {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}
/** A path as the reader shows it: the home folder as `~`, in this OS's separator */
const T = (p: string) => p.replaceAll('/', sep)
/** The fake ssh is a shell script, and `chmod` takes no read permission away on Windows */
const posix = process.platform !== 'win32'
const aliases = () => readSshConfig({ file: join(home, '.ssh', 'config'), home }).hosts.map((h) => h.alias)

describe('one config line, split as OpenSSH splits it', () => {
  it.each([
    ['Host a b', 'host', ['a', 'b']],
    ['  host\ta', 'host', ['a']],
    ['Host=a', 'host', ['a']],
    ['Host = a  b', 'host', ['a', 'b']],
    ['Host "my box" other', 'host', ['my box', 'other']],
    ["Host 'single' \"dou\\\"ble\"", 'host', ['single', 'dou"ble']],
    ['Host a # a comment', 'host', ['a']],
    ['HostName x#y', 'hostname', ['x#y']],
    ['Include "conf d/*" ~/x', 'include', ['conf d/*', '~/x']],
    ['Host a\r', 'host', ['a']],
  ])('%j', (line, keyword, args) => {
    expect(splitConfigLine(line)).toEqual({ keyword, args })
  })

  it('a blank line and a comment are nothing', () => {
    expect(splitConfigLine('')).toBeNull()
    expect(splitConfigLine('   ')).toBeNull()
    expect(splitConfigLine('# Host a')).toBeNull()
    expect(splitConfigLine('   # Host a')).toBeNull()
  })

  it('a pattern, a negation or a name with a space is not an alias the person can link', () => {
    expect(['box', 'user@x', 'a.example.com', '10.0.0.2'].every(isConcreteAlias)).toBe(true)
    expect(['*', '*.example', 'web?', '!bad', '', '-oProxyCommand=x', 'my box'].some(isConcreteAlias)).toBe(false)
  })
})

describe('the hosts of a config and what it includes', () => {
  it('lists every concrete alias once, in file order, and skips patterns and negations', () => {
    write(
      '.ssh/config',
      ['Host *', '  ServerAliveInterval 30', 'Host web db', '  User me', 'Host *.example !bad good', 'Host "quoted"', 'Host web', 'Host lab?'].join('\n'),
    )
    expect(aliases()).toEqual(['web', 'db', 'good', 'quoted'])
  })

  it('says where each alias is declared, with the home folder as ~', () => {
    write('.ssh/config', '\n# hosts\nHost box\n')
    expect(readSshConfig({ file: join(home, '.ssh', 'config'), home }).hosts).toEqual([{ alias: 'box', file: T('~/.ssh/config'), line: 3 }])
  })

  it('reads an Include where it stands: relative to ~/.ssh, globbed and sorted, ~ and absolute paths too', () => {
    const abs = write('elsewhere/abs.conf', 'Host abs\n')
    write('.ssh/config.d/b.conf', 'Host from-b\n')
    write('.ssh/config.d/a.conf', 'Host from-a\n')
    write('.ssh/config.d/.hidden', 'Host hidden\n')
    write('.ssh/config.d/sub/deep.conf', 'Host not-matched-by-star\n')
    write('.orbstack/ssh/config', 'Host orb\n')
    write('.ssh/config', ['Host first', 'Include config.d/*', 'Host middle', `Include ~/.orbstack/ssh/config ${abs}`, 'Include missing/* nothing-here', 'Host last'].join('\n'))
    expect(aliases()).toEqual(['first', 'from-a', 'from-b', 'middle', 'orb', 'abs', 'last'])
  })

  it('reads an Include inside a Host block too, as ssh declares the hosts in it either way', () => {
    write('.ssh/work', 'Host inner\n')
    write('.ssh/config', 'Host outer\n  User me\n  Include work\n')
    expect(aliases()).toEqual(['outer', 'inner'])
  })

  it('leaves Match blocks out with one note, and still lists a Host after them', () => {
    write('.ssh/config', ['Match host *.corp exec "true"', '  User corp', 'Host after', 'Match all', '  Compression yes'].join('\n'))
    const r = readSshConfig({ file: join(home, '.ssh', 'config'), home })
    expect(r.hosts.map((h) => h.alias)).toEqual(['after'])
    expect(r.notes).toEqual([`2 Match blocks (${T('~/.ssh/config')}:1, ${T('~/.ssh/config')}:4) are not listed; ssh still applies them`])
  })

  it('reads a file that includes itself once, with a note, instead of looping', () => {
    write('.ssh/config', 'Host a\nInclude config\nHost b\n')
    const r = readSshConfig({ file: join(home, '.ssh', 'config'), home })
    expect(r.hosts.map((h) => h.alias)).toEqual(['a', 'b'])
    expect(r.notes).toEqual([`${T('~/.ssh/config')} includes itself; it was read once`])
  })

  // OpenSSH's READCONF_MAX_DEPTH is 16: across the limit, each step of nesting
  it.each([14, 15, 16, 17, 18])('Includes nested %i deep: read up to 16, refused past it with a note', (depth) => {
    for (let i = 0; i <= depth; i++) write(`.ssh/n${i}`, `Host level-${i}\n${i < depth ? `Include n${i + 1}\n` : ''}`)
    write('.ssh/config', 'Include n0\n')
    const r = readSshConfig({ file: join(home, '.ssh', 'config'), home })
    // config is depth 0, n0 depth 1, … n15 depth 16
    expect(r.hosts.length).toBe(Math.min(depth + 1, 16))
    expect(r.notes.some((n) => n.includes('nested more than 16 deep'))).toBe(depth >= 16)
  })

  it('a missing config is no hosts and no note; an unreadable Include is a note', () => {
    expect(readSshConfig({ file: join(home, '.ssh', 'config'), home })).toEqual({ hosts: [], notes: [] })
    const locked = write('.ssh/locked', 'Host secret\n')
    chmodSync(locked, 0o000)
    write('.ssh/config', 'Include locked\nHost open\n')
    const r = readSshConfig({ file: join(home, '.ssh', 'config'), home })
    chmodSync(locked, 0o600)
    // root reads anything; the note is what a person's account gets
    if (posix && process.getuid?.() !== 0) {
      expect(r.hosts.map((h) => h.alias)).toEqual(['open'])
      expect(r.notes).toEqual([`${T('~/.ssh/locked')} could not be read`])
    }
  })

  it('reads no file an IdentityFile or other keyword names, only Includes', () => {
    write('.ssh/id_box', 'Host leaked-from-a-key-file\n')
    write('.ssh/known', 'Host leaked-from-known-hosts\n')
    write('.ssh/config', 'Host box\n  IdentityFile ~/.ssh/id_box\n  UserKnownHostsFile ~/.ssh/known\n  CertificateFile id_box\n')
    expect(aliases()).toEqual(['box'])
  })

  it('globs ? and [...] in any segment, and a missing folder matches nothing', () => {
    write('.ssh/d1/x.conf', '')
    write('.ssh/d2/x.conf', '')
    write('.ssh/d2/y.conf', '')
    expect(expandGlob(join(home, '.ssh/d?/x.conf'))).toEqual([join(home, '.ssh/d1/x.conf'), join(home, '.ssh/d2/x.conf')])
    expect(expandGlob(join(home, '.ssh/d2/[!x].conf'))).toEqual([join(home, '.ssh/d2/y.conf')])
    expect(expandGlob(join(home, '.ssh/none/*'))).toEqual([])
  })
})

describe('resolving each alias with ssh -G', () => {
  it('reads hostname, user and port from ssh -G, the first of each', () => {
    expect(parseSshG('user me\nhostname box.ts.net\nport 38222\nidentityfile ~/.ssh/id_ed25519\nhostname later\n')).toEqual({
      hostName: 'box.ts.net',
      user: 'me',
      port: 38222,
    })
    expect(parseSshG('')).toEqual({ hostName: null, user: null, port: null })
  })

  it.skipIf(!posix)('asks the real ssh binary only for -G, never to connect, and lists what it resolved', async () => {
    const log = join(home, 'ssh.log')
    // A fake ssh: logs its arguments, and answers -G as OpenSSH does (the alias as hostname unless the config says otherwise)
    const fake = write(
      'bin/ssh',
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nfor a; do last="$a"; done\nif [ "$last" = broken ]; then echo "ssh: bad config line" >&2; exit 255; fi\nprintf 'user me\\nhostname %s.lan\\nport 2222\\n' "$last"\n`,
    )
    chmodSync(fake, 0o755)
    write('.ssh/config', 'Host box lab\nHost broken\n')
    const r = await listSshHosts({ home, ssh: fake })
    expect(r.configFile).toBe(T('~/.ssh/config'))
    expect(r.hosts).toEqual([
      { alias: 'box', file: T('~/.ssh/config'), line: 1, hostName: 'box.lan', user: 'me', port: 2222 },
      { alias: 'lab', file: T('~/.ssh/config'), line: 1, hostName: 'lab.lan', user: 'me', port: 2222 },
      { alias: 'broken', file: T('~/.ssh/config'), line: 2, hostName: null, user: null, port: null },
    ])
    expect(readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual(['-G -- box', '-G -- broken', '-G -- lab'])
  })

  /** Each chunk was decoded on its own, so a character split between two turned into U+FFFD (#428) */
  it.skipIf(!posix)('reads a reason from ssh -G whose character arrives in two pieces as one character', async () => {
    const fake = write(
      'bin/ssh-split',
      `#!/usr/bin/env node\nconst b = Buffer.from('설정 오류: 잘못된 줄\\n'); process.stderr.write(b.subarray(0, 4)); setTimeout(() => { process.stderr.write(b.subarray(4)); process.exit(255) }, 200)\n`,
    )
    chmodSync(fake, 0o755)
    expect(await resolveAlias('box', { ssh: fake })).toEqual({ hostName: null, user: null, port: null, error: '설정 오류: 잘못된 줄' })
  })

  it('says so when ssh cannot resolve any of them (no ssh on this computer)', async () => {
    write('.ssh/config', 'Host box\n')
    const r = await listSshHosts({ home, ssh: join(home, 'no-such-ssh') })
    expect(r.hosts.map((h) => h.hostName)).toEqual([null])
    expect(r.notes[0]).toMatch(/^ssh -G could not resolve the hosts: Could not run ssh/)
  })

  // The cap on how many aliases are resolved, at and around it and well past it
  it.each([0, 1, MAX_HOSTS - 1, MAX_HOSTS, MAX_HOSTS + 1, 3 * MAX_HOSTS])('%i aliases: at most MAX_HOSTS listed and resolved, 8 at a time, the rest said in a note',async (n) => {
    write('.ssh/config', Array.from({ length: n }, (_, i) => `Host h${i}`).join('\n'))
    const asked: string[] = []
    let running = 0
    let most = 0
    const resolve = async (alias: string): Promise<ResolvedHost> => {
      asked.push(alias)
      most = Math.max(most, ++running)
      await new Promise((r) => setTimeout(r, 1))
      running--
      return { hostName: `${alias}.lan`, user: null, port: 22, error: null }
    }
    const r = await listSshHosts({ home, resolve })
    expect(r.hosts.length).toBe(Math.min(n, MAX_HOSTS))
    expect(asked.length).toBe(Math.min(n, MAX_HOSTS))
    expect(r.hosts.every((h) => h.hostName === `${h.alias}.lan`)).toBe(true)
    expect(most).toBeLessThanOrEqual(8)
    expect(r.notes).toEqual(n > MAX_HOSTS ? [`Only the first ${MAX_HOSTS} of ${n} hosts are listed; type any other below`] : [])
  })
})
