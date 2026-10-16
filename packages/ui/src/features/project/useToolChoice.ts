import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolName, ToolStatus } from '@cc/protocol'
import type { MachineRef } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useToolMeta } from '../../store/selectors.js'

/**
 * Which agent tool a creation dialog (a new session, a new app's builder) starts, and whether it can.
 *
 * `tools` is asked for **again, every time the dialog opens** — the person may have just installed
 * or logged in. It is asked on `machine` when there is one (#82): a session in a project on a linked
 * machine runs that machine's CLIs, so whether one is installed and logged in is that machine's
 * answer, not this computer's.
 *
 * The app has to work normally even when only **one** of the two tools is usable (a product rule).
 * If the default tool is unusable but the other one works fine, this **silently switches to it.**
 * Otherwise, a person who only uses Codex would hit a "log in to Claude" wall every time they
 * opened the dialog, needing to log into a tool they never use just to open it — a direct
 * violation of this app's principle ("do not force a workflow on the person").
 *
 * The switch happens **exactly once**, the moment detection results first arrive. Anything the
 * person picks after that is left untouched.
 *
 * @param initial the tool shown selected before detection answers; the dialog always sends the tool
 * actually selected, so a wrong guess never starts a session with another tool than the one shown
 */
export function useToolChoice(initial: ToolName, machine?: MachineRef) {
  const platform = usePlatform()
  const [tool, setTool] = useState<ToolName>(initial)
  const toolMeta = useToolMeta(tool)
  const [tools, setTools] = useState<ToolStatus[] | null>(null)

  const detect = useCallback(async () => {
    try {
      setTools(await platform.agents.detect(machine))
    } catch {
      setTools([])
    }
  }, [platform, machine])
  useEffect(() => {
    void detect()
  }, [detect])

  const autoPicked = useRef(false)
  useEffect(() => {
    if (!tools || autoPicked.current) return
    autoPicked.current = true
    const ok = (t: ToolName) => {
      const d = tools.find((x) => x.name === t)
      return d?.installed === true && d.loggedIn
    }
    setTool((cur) => (ok(cur) ? cur : (tools.find((x) => x.installed && x.loggedIn)?.name ?? cur)))
  }, [tools])

  const info = (t: ToolName) => tools?.find((x) => x.name === t)
  const usable = (t: ToolName) => {
    const d = info(t)
    return !tools || (d?.installed === true && d.loggedIn)
  }
  const blocked = tools ? !usable(tool) : false
  return { tool, setTool, toolMeta, tools, info, usable, blocked }
}
