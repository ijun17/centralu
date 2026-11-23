import { useEffect } from 'react'
import { APP_VERSION } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { applyWords, installedUpdate, applyOffer, updateStateText, useRelaunchCheck, useUpdateCheckWhileOpen } from './apply-update.js'
import { SettingToggle } from './SettingToggle.jsx'
import { Button } from '../../components/Button.jsx'
import { More, SettingsGroup, SettingsRow } from './SettingsLayout.jsx'

/**
 * Updates (#43): what runs, what is out there, and the person decides. It upgrades by itself only with "Automatic
 * updates" on (one switch for checking and applying, #352), and even then waits until nothing runs and nobody types:
 * the swap is not reversible. The host checks, not the launcher, whose installed copy can compare wrongly (#42).
 */
export function UpdatesSection() {
  const reportedUpdate = useStore((s) => s.update)
  const checkUpdate = useStore((s) => s.checkUpdate)
  useUpdateCheckWhileOpen()
  const setUpdateAuto = useStore((s) => s.setUpdateAuto)
  const setUpdateAutoApply = useStore((s) => s.setUpdateAutoApply)
  const applyUpdate = useStore((s) => s.applyUpdate)
  const applyUpdateNow = useStore((s) => s.applyUpdateNow)
  const relaunch = useRelaunchCheck()
  const update = installedUpdate(reportedUpdate, APP_VERSION, relaunch)
  const offer = update?.phase === 'restart_required' ? applyOffer(update, APP_VERSION, relaunch) : null
  const words = applyWords(relaunch)
  // One switch for the host's `auto` (checking) and `autoApply` (applying when idle): on only when both are, and turning
  // it on sets both. Saved one after the other; the switch holds until both answers are back.
  const automatic = update ? update.auto && update.autoApply === true : false
  const setAutomatic = async (on: boolean) => {
    await setUpdateAuto(on)
    await setUpdateAutoApply(on)
  }

  // The current version shows before the host answers: the same build's constant (`tooling/brand.test.ts` keeps it
  // identical), and a comparison missing one side cannot be read
  const current = update?.current ?? APP_VERSION
  const busy = update?.phase === 'checking' || update?.phase === 'updating' || update?.phase === 'waiting_for_npm'

  return (
    <SettingsGroup
      title="Centralu"
      hint={
        <>
          Centralu updates through npm, the same way it was installed.
          <More>
            Checking only asks the registry which version is newest. With automatic updates off, installing happens when
            you ask for it. {words.applying}
          </More>
        </>
      }
    >
      <SettingsRow
        label={<span data-testid="update-current">Running {current}</span>}
        hint={<span data-testid="update-state">{updateStateText(update, offer)}</span>}
        control={
          <>
            <Button variant="quiet" size="sm" data-testid="update-check-now" disabled={busy} onClick={() => void checkUpdate(true)}>
              Check now
            </Button>
            {update?.newer && update.latest && update.phase !== 'restart_required' && (
              <Button variant="secondary" size="sm" data-testid="update-apply" disabled={busy} onClick={() => void applyUpdate()}>
                Update to {update.latest}
              </Button>
            )}
            {offer?.kind === 'apply' && (
              <Button variant="secondary" size="sm" data-testid="update-apply-now-settings" onClick={() => void applyUpdateNow()}>
                Apply now
              </Button>
            )}
          </>
        }
      />

      {/* The hint says what goes out, as no request goes silently. Applying needs a window that can relaunch (#352);
          its cost and idle wait are `applyWords` (#1895 step 3) */}
      <SettingToggle
        checked={automatic}
        disabled={update === null}
        onChange={setAutomatic}
        label="Automatic updates"
        hint={words.hint}
        more={
          <>
            It asks the public npm registry for one version number and nothing else: at startup, every six hours, and on
            focus if the last check is over an hour old. {words.more} If it cannot reach the registry, nothing happens and
            nothing interrupts you.
          </>
        }
        testId="update-auto"
      />
    </SettingsGroup>
  )
}

/**
 * The agent CLIs (#297): installed versions, and whether idle sessions move to a newer one by themselves; beside the
 * app's update, as the same errand. On by default, unlike it (owner's decision): nothing is installed here, and a move
 * waits until nothing would be lost. The conversation continues, with a line saying it moved.
 */
export function AgentCliUpdates() {
  const versions = useStore((s) => s.agentVersions)
  const tools = useStore((s) => s.tools)
  const setAutoApply = useStore((s) => s.setAgentAutoApply)
  const check = useStore((s) => s.checkAgentVersions)
  useEffect(() => {
    void check(false)
  }, [check])
  const installed = Object.entries(versions?.installed ?? {})
    .filter(([, v]) => v)
    .map(([tool, v]) => `${tools.find((t) => t.name === tool)?.label ?? tool} ${v}`)
  return (
    <SettingsGroup testId="settings-agent-versions" title="Agent CLIs">
      <SettingsRow
        label={
          <span data-testid="agent-versions-installed">
            {versions === null ? 'Agent CLIs: not checked yet' : installed.length > 0 ? `Installed: ${installed.join(' · ')}` : 'No agent CLI version found'}
          </span>
        }
      />
      <SettingToggle
        checked={versions?.autoApply ?? true}
        disabled={versions === null}
        onChange={setAutoApply}
        label="Move idle sessions to a newly installed agent CLI"
        hint="A session restarts on the newer one once it is idle; its conversation continues."
        more={
          <>
            Each session runs its own agent process, which keeps the version it started with. With this on, a
            session restarts on the newer one once it is not working, not waiting for you and not running background tasks.
            The conversation continues, and a line in it says the session moved.
          </>
        }
        testId="agent-versions-auto-apply"
      />
    </SettingsGroup>
  )
}
