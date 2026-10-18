import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Declarations, helpSurface, literalsOf, membersOf, methodsOf } from './surface-read.js'

const fixture = (name: string) => readFileSync(new URL(`./surface-fixtures/${name}`, import.meta.url), 'utf8')

describe('helpSurface', () => {
  // Recorded 2026-10-18: `claude --help` of Claude Code 2.1.302 (commander), `codex --help` of codex-cli 0.163.0 (clap)
  const claude = helpSurface(fixture('claude-2.1.302-help.txt'))
  const codex = helpSurface(fixture('codex-0.163.0-help.txt'))

  it('reads every name of a flag line, aliases included', () => {
    expect(claude).toEqual(expect.arrayContaining(['flag:--allowedTools', 'flag:--allowed-tools', 'flag:--print', 'flag:--bg', 'flag:--background']))
    expect(codex).toEqual(expect.arrayContaining(['flag:--config', 'flag:--enable', 'flag:--add-dir']))
  })

  it('reads every name of a command line, aliases included', () => {
    expect(claude).toEqual(expect.arrayContaining(['subcommand:plugin', 'subcommand:plugins', 'subcommand:stop', 'subcommand:kill']))
    expect(codex).toEqual(expect.arrayContaining(['subcommand:app-server', 'subcommand:exec', 'subcommand:features']))
  })

  it('does not take a flag a description only mentions for one the CLI lists', () => {
    // 2.1.302's `--permission-prompts` description names `--permission-prompt-tool`, which help does not list
    expect(fixture('claude-2.1.302-help.txt')).toContain('--permission-prompt-tool')
    expect(claude).not.toContain('flag:--permission-prompt-tool')
  })

  it("leaves out what every CLI has: --help, --version and help", () => {
    for (const read of [claude, codex]) {
      expect(read).not.toContain('flag:--help')
      expect(read).not.toContain('flag:--version')
      expect(read).not.toContain('subcommand:help')
    }
  })

  it('reads the same from a CRLF copy', () => {
    expect(helpSurface(fixture('codex-0.163.0-help.txt').replace(/\n/g, '\r\n'))).toEqual(codex)
  })

  it('throws on a help it reads nothing from, rather than reporting every name as gone', () => {
    expect(() => helpSurface('Usage: tool\n\nSomething else entirely.\n')).toThrow(/format/)
  })
})

describe('Declarations', () => {
  // An excerpt of @anthropic-ai/claude-agent-sdk 0.3.302's sdk.d.ts (see its header)
  const d = new Declarations(fixture('claude-sdk-0.3.302-excerpt.d.ts.txt'))

  it('follows a union through namespaced names and aliases of unions to its object types', () => {
    const objects = d.objectsOf('StdoutMessage')
    const types = objects.flatMap((o) => literalsOf(o, 'type'))
    expect(types).toEqual(expect.arrayContaining(['active_goal', 'assistant', 'result', 'system', 'control_request', 'keep_alive']))
    // SDKResultMessage = SDKResultSuccess | SDKResultError: both, each a `result`
    expect(types.filter((t) => t === 'result')).toHaveLength(2)
  })

  it("reads a member's literal union", () => {
    const results = d.objectsOf('SDKResultMessage').flatMap((o) => literalsOf(o, 'subtype'))
    expect(results).toEqual(expect.arrayContaining(['success', 'error_during_execution']))
  })

  it('lists the members of a type alias and of an interface', () => {
    expect(d.members('Options')).toEqual(expect.arrayContaining(['resume', 'canUseTool', 'pathToClaudeCodeExecutable']))
    expect(d.members('Query')).toEqual(expect.arrayContaining(['interrupt', 'supportedCommands', 'getContextUsage']))
  })

  it('is not misled by brackets, quotes and semicolons in doc comments', () => {
    const dts = [
      '/** A comment with { an open brace; and a quote \' */',
      'export declare type A = {',
      '    /** `{ type: "fake" }`; */',
      "    type: 'a';",
      "    subtype?: 'x' | 'y';",
      '    run(cb: (e: { n: number }) => void): Promise<void>;',
      '};',
      'declare type U = A | ns.B;',
      "declare type B = { type: 'b' } & { extra: string };",
    ].join('\n')
    const u = new Declarations(dts)
    expect(u.objectsOf('U').flatMap((o) => literalsOf(o, 'type'))).toEqual(['a', 'b'])
    expect(u.objectsOf('U').flatMap((o) => literalsOf(o, 'subtype'))).toEqual(['x', 'y'])
    expect(u.members('A')).toEqual(['type', 'subtype', 'run'])
  })

  it('throws on a name it cannot find or a member it cannot read', () => {
    expect(() => d.members('NoSuchType')).toThrow(/NoSuchType is not declared/)
    expect(() => new Declarations("declare type U = 'a' | 'b';").objectsOf('U')).toThrow(/cannot read the union member/)
    expect(() => membersOf("'a'")).toThrow(/not an object type/)
  })
})

describe('methodsOf', () => {
  it('reads the method names of a generated JSON-RPC union', () => {
    const src = 'export type R = { "method": "turn/start", id: RequestId, params: P, } | { "method": "initialize", id: RequestId, params: I, };'
    expect(methodsOf(src, 'R')).toEqual(['initialize', 'turn/start'])
  })

  it('throws on a union with no methods', () => {
    expect(() => methodsOf('export type R = never;', 'R')).toThrow(/declares no methods/)
  })
})
