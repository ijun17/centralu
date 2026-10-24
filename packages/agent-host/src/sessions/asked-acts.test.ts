import { describe, expect, it } from 'vitest'
import { ORCHESTRATOR_TOOLS, AGENT_TOOLS, APP_ACCESS_TOOLS } from './tool-definitions.js'
import { askedAct, askedQuestion } from './asked-acts.js'

const THREAD = 'hub-aaaaaaaa.t_01'

describe('which steps of the orchestrator ask the person when a session asked for them (§9.7)', () => {
  it('reading needs no card', () => {
    for (const name of ['list_sessions', 'read_session', 'recall', 'usage_history', 'get_preferences', 'list_machines', 'list_projects', 'project_git_status', 'list_app_runs', 'find_apps', 'centralu_commands', 'centralu_help']) {
      expect(askedAct(name, {}, THREAD), name).toBeNull()
    }
    expect(askedAct('update_centralu', { action: 'check' }, THREAD)).toBeNull()
    expect(askedAct('agent_session', { action: 'status', sessionId: 's' }, THREAD)).toBeNull()
  })

  it('everything that changes sessions, projects, settings, machines, installations or apps, starts agents, or deletes asks', () => {
    for (const name of ['send_to_session', 'create_session', 'update_session_settings', 'create_project', 'add_project', 'add_machine', 'install_machine', 'remove_machine', 'set_preferences', 'set_project_trust', 'set_agent_limits', 'remove_approval_rule', 'delete_session', 'delete_archived', 'delete_all_archived', 'search_project_files', 'check_app', 'check', 'rename_session', 'restart_app', 'remove_app', 'create_app', 'handoff_session', 'start_agent', 'ask_project', 'answer_question', 'attach_app', 'update_centralu']) {
      expect(askedAct(name, name === 'update_centralu' ? { action: 'install' } : {}, THREAD), name).not.toBeNull()
    }
    expect(askedAct('agent_session', { action: 'send', sessionId: 's' }, THREAD)).not.toBeNull()
    expect(askedAct('agent_session', { action: 'delete', sessionId: 's' }, THREAD)).not.toBeNull()
  })

  it('a command nobody classified asks: the list of what only reads is the short one', () => {
    expect(askedAct('some_command_added_later', {}, THREAD)).toMatch(/^run some_command_added_later/)
  })

  it('every tool the orchestrator is shown is either on the reading list or asks, and nothing that only reads was left asking by mistake', () => {
    const reads = [...ORCHESTRATOR_TOOLS, ...AGENT_TOOLS, ...APP_ACCESS_TOOLS].map((t) => t.name).filter((n) => askedAct(n, {}, THREAD) === null)
    // The reading list, as the orchestrator is given the tools (a new reading tool is added here on purpose)
    expect([...new Set(reads)].sort()).toEqual(
      ['agent_models', 'agent_status', 'app_guide', 'app_usage', 'find_apps', 'get_preferences', 'list_app_errors', 'list_app_grants', 'list_app_runs', 'list_app_versions', 'list_approval_rules', 'list_archive', 'list_machines', 'list_projects', 'list_sessions', 'list_ssh_hosts', 'machine_activity', 'project_git_status', 'read_session', 'recall', 'usage_history'].sort(),
    )
  })

  it('mail: reading and answering in the request’s own thread are free; a word to anyone else, or in another thread, asks', () => {
    for (const action of ['inbox', 'read', 'handled']) expect(askedAct('mail', { action, thread: 'other' }, THREAD), action).toBeNull()
    for (const action of ['reply', 'update', 'close']) {
      expect(askedAct('mail', { action, thread: THREAD }, THREAD), action).toBeNull()
      expect(askedAct('mail', { action, thread: 'hub-aaaaaaaa.t_02' }, THREAD), action).not.toBeNull()
    }
    expect(askedAct('mail', { action: 'send', to: 'person', text: 'x' }, THREAD)).toBeNull()
    expect(askedAct('mail', { action: 'send', to: 'some-session', text: 'x' }, THREAD)).not.toBeNull()
  })

  it('the act is one short line, with a long argument cut', () => {
    const act = askedAct('send_to_session', { sessionId: 's1', text: 'x'.repeat(5_000) + '\nsecond line' }, THREAD)!
    expect(act).not.toContain('\n')
    expect(act.length).toBeLessThanOrEqual(500)
    expect(act).toMatch(/^run send_to_session \{"sessionId":"s1"/)
  })

  it('the question names the session and its project, and says when the project is not trusted', () => {
    expect(askedQuestion({ name: 'Fix login', project: 'Acme', trusted: true }, 'run rename_session {}')).toBe(
      `Session "Fix login" in project "Acme" asked the orchestrator to run rename_session {}. It is the session's request, not yours.`,
    )
    expect(askedQuestion({ name: 'Fix login', project: 'Wild', trusted: false }, 'x')).toContain('in project "Wild" (not trusted) asked')
    expect(askedQuestion({ name: 'S', project: null, trusted: false }, 'x')).toContain('Session "S" with no project asked')
    // A name cannot close its quote and pass for a project
    expect(askedQuestion({ name: 'x" in project "centralu', project: 'P', trusted: true }, 'y')).toContain('Session "x\\" in project \\"centralu" in project "P" asked')
  })
})
