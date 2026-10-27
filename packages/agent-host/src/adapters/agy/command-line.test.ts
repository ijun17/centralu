import { describe, expect, it } from 'vitest'
import { knownProgram, readCommandLine } from './command-line.js'

/**
 * A command line read into the commands the shell runs (docs/plans/antigravity-adapter.md §5.5), for the person's
 * command deny rules and the plugin root's refusal. The rules' own cases are in deny-rules.test.ts.
 */

const texts = (line: string) => readCommandLine(line).commands.map((c) => c.map((w) => w.text).join(' '))

describe('reading a command line', () => {
  it('takes quotes and backslashes out of each word', () => {
    expect(texts(`"echo" 'a b' c\\ d e"f"g`)).toEqual(['echo a b c d efg'])
  })

  it('splits compound commands and reads substitutions, subshells and here-strings as commands', () => {
    expect(texts('a; b && c | d')).toEqual(['a', 'b', 'c', 'd'])
    // The assignment before the program is not the program
    expect(texts('x=$(inner one) outer')).toEqual(['inner one', 'outer'])
    // A process substitution is a file name to its command: a word whose text the shell makes
    expect(texts('(sub) && cat <(proc)')).toEqual(['sub', 'proc', 'cat '])
    expect(texts('bash <<< "here cmd"')).toEqual(['here cmd', 'bash'])
  })

  it("reads a shell's -c script and eval again, and every word after a wrapper as a possible program", () => {
    expect(texts(`bash -lc 'in side'`)).toEqual(['bash -lc in side', 'in side'])
    expect(texts('eval a b')).toEqual(['eval a b', 'a b'])
    expect(texts('sudo -u x rm f')).toEqual(['sudo -u x rm f', '-u x rm f', 'x rm f', 'rm f', 'f'])
  })

  it('drops redirections and comments, which the shell does not run as words', () => {
    expect(texts('2>/dev/null cmd arg >out <in # ; hidden')).toEqual(['cmd arg'])
  })

  it('marks a word the shell would change, and knows a program through a path after the change', () => {
    const [w] = readCommandLine('$HOME/bin/rm x').commands[0] ?? []
    expect(w).toMatchObject({ dynamic: true })
    expect(knownProgram(w!)).toBe(true)
    for (const line of ['$X y', '$(p) y', 'e*o y', '{a,b} y']) {
      // The outer command comes after the ones inside it
      const first = readCommandLine(line).commands.at(-1)?.[0]
      expect(first && knownProgram(first), line).toBe(false)
    }
  })

  it('is not confident about an unclosed quote or substitution, or a -c script that is a variable', () => {
    for (const line of ["echo 'x", 'echo "x', 'echo $(x', 'bash -c "$S"', 'eval $X']) expect(readCommandLine(line).confident, line).toBe(false)
    expect(readCommandLine(`bash -c 'echo ok'`).confident).toBe(true)
  })
})
