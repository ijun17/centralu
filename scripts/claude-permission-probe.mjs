/**
 * Exercise query's argument builder, stopping at the spawn boundary. No CLI, model,
 * or tool runs. SDK 0.3.295 changed --flag value to --flag=value; either is valid.
 * This probes the explicit modes the adapter sends, rather than minifier spelling.
 */
export function permissionModeFindings(query, cwd) {
  const findings = []
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']) {
    let args
    const stop = new Error('permission probe: stop before spawning')
    try {
      const q = query({
        prompt: 'This prompt must never reach a CLI.',
        options: {
          cwd,
          settingSources: [],
          permissionMode: mode,
          pathToClaudeCodeExecutable: process.execPath,
          spawnClaudeCodeProcess: (spec) => {
            args = spec.args
            throw stop
          },
        },
      })
      q.close()
      findings.push(`runtime: ${mode}: query did not reach the synchronous spawn boundary`)
      continue
    } catch (error) {
      if (error !== stop) {
        findings.push(`runtime: ${mode}: query failed before the spawn probe: ${error.message}`)
        continue
      }
    }
    const modes = args.flatMap((arg, i) =>
      arg === '--permission-mode' ? [args[i + 1]] : arg.startsWith('--permission-mode=') ? [arg.slice('--permission-mode='.length)] : [],
    )
    if (modes.length !== 1 || modes[0] !== mode) {
      findings.push(`runtime: permissionMode ${mode} reached the CLI as ${JSON.stringify(modes)}`)
    }
    if (mode !== 'bypassPermissions' && args.some((arg) => arg.split('=')[0] === '--dangerously-skip-permissions')) {
      findings.push(`runtime: ${mode} unexpectedly enables bypassPermissions`)
    }
  }
  return findings
}
