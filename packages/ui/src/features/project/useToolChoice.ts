import { useEffect, useRef, useState } from 'react'
import { launchRefusal, type AdapterCapabilities, type LaunchDemands, type ToolName, type ToolStatus } from '@cc/protocol/client'
import type { MachineRef } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { useToolMeta } from '../../store/selectors.js'
import { useLiveTools, useReloadOnReconnect } from '../tools/useToolSetup.js'

/**
 * Which agent tool a creation dialog (new session, new app's builder) starts, and whether it can. `tools` is asked
 * again on every open (an install or login may be new), on `machine` when there is one (#82: its CLIs are its own).
 *
 * The app must work with only one usable tool (a product rule): when detection first answers, an unusable default
 * switches silently to a usable tool, so a Codex-only person never meets a Claude login wall. Later picks are kept.
 *
 * A failed detection is not an answer (#850 item 8): `tools` stays null, so nothing is blocked (the host still refuses)
 * and `detectError` says why, with a retry. Read as empty, it would call every tool not installed. A tool that cannot
 * keep `demands` is not usable either (`useRefusals`).
 *
 * @param initial the tool shown before detection; the selected tool is what is sent, so a wrong guess starts nothing
 */
export function useToolChoice(initial: ToolName, machine?: MachineRef, demands?: LaunchDemands) {
  const platform = usePlatform()
  const [tool, setTool] = useState<ToolName>(initial)
  const toolMeta = useToolMeta(tool)
  const detected = useLoad<ToolStatus[]>(() => platform.agents.detect(machine), [platform, machine])
  // This computer's live setups over the list: a sign-in that just succeeded enables Start without asking again
  const tools = useLiveTools(detected.data ?? null, machine)
  useReloadOnReconnect(detected.reload)
  const refusal = useRefusals(tools, demands, machine)

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

  function info(t: ToolName) {
    return tools?.find((x) => x.name === t)
  }
  const usable = (t: ToolName) => {
    const d = info(t)
    return !tools || (d?.installed === true && d.loggedIn && refusal(t) === null)
  }
  const blocked = tools ? !usable(tool) : false
  return { tool, setTool, toolMeta, tools, info, usable, refusal, blocked, detectError: detected.error, redetect: detected.reload }
}

/** What the Assistant's seat asks of a tool: its role as text, and no setting files read (#92) */
export { ASSISTANT_DEMANDS } from '@cc/protocol/client'

/**
 * Why each of `tools` cannot run a start that asks `demands`, in the host's words (`launchRefusal`, the rule the host
 * refuses it with), or null. Each tool's capabilities are asked once per list; until they answer nothing is refused.
 */
export function useRefusals(tools: readonly ToolStatus[] | null, demands: LaunchDemands | undefined, machine?: MachineRef): (t: ToolName) => string | null {
  const platform = usePlatform()
  const caps = useLoad<Map<ToolName, AdapterCapabilities>>(
    async () =>
      new Map(
        (await Promise.all((tools ?? []).map((t) => platform.agents.capabilities(t.name, machine).then((c) => [t.name, c] as const, () => null)))).filter(
          (e): e is readonly [ToolName, AdapterCapabilities] => e !== null,
        ),
      ),
    [platform, machine, tools],
  ).data
  return (t) => {
    const c = caps?.get(t)
    return c && demands ? launchRefusal(c, tools?.find((x) => x.name === t)?.label ?? t, demands) : null
  }
}
