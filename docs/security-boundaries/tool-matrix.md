# What each session's tools can do (#382)

One place for what each kind of session can call and when the person is asked. Each piece was
decided in its own issue; this is the whole matrix, audited against the code before 1.0.

## Which tools a session has

The host gives a session one profile (`toolProfileFor` in `sessions/tool-profiles.ts`, asked through
`SessionTools.toolProfileOf`), and the profile
decides both which tools the session sees and which calls run (`profileAllows` in
`sessions/centralu-tools.ts`). Claude's in-process server is built from the profile
(`adapters/claude/centralu-mcp.ts`, `toolDefsFor`); Codex calls through the bridge, and the host
checks the profile again on every call (`SessionManager.runCentraluTool`), so a name the
session was not given is refused even when the bridge asks for it. The arguments are checked once
for both paths, against the tool's one schema (`TOOL_ARGS`, #850): Claude's server checks them against
the definition it shows, and the bridge hands them over unchecked. The bridge connects with a
credential for its own session's bridge calls, not with the host's token (owner question 4; "The front door" in [keeper.md](keeper.md#the-front-door)).

| Profile | Which sessions | What its tools see |
|---|---|---|
| `assistant` | The Assistant | Every session |
| `scoped` | A coordinating session | Its member sessions |
| `builder` | An app's builder session | Its own app (`check`) |
| `reader` | Every other session in a project (always: "Let sessions look at other sessions" is no longer a setting, owner decision 2026-10-20, and a stored "off" is not read) | From a trusted project, reads every session on this computer and the linked machines but an Assistant's (#984, #1941); from an untrusted one, its own project only; acts only on the agents it started (`start_agent`: the project's trust under `normal`, a consent card under `safe`, #673) and another project only through a consent card |
| none | A session with no project, and an agent an app started (`run_agent`) | No Centralu server at all |

The worktree manager's profile (`manager`: list, read and send to its worktree sessions, propose one, delete a merged
one) was folded into ordinary sessions (#561 part 3): a session starts worktree agents itself with `start_agent`, works
with them through `agent_session`, and removes an idle child with `agent_session` `delete`. The parent decides in every preset; local work is
set aside with the archived session before removal (#608). A former manager is an ordinary `reader` that owns the worktree sessions it held (store v48).

The matrix below is checked against `profileAllows` and `toolDefsFor` by a test
(`sessions/tool-matrix.test.ts`), so adding a tool or moving one between profiles fails until this
table says the same. "yes" means the session sees the tool and its calls run; "—" means the tool
is not listed for it and a call by name is refused (`Not a tool of this session`).

<!-- tool-matrix:start -->
| Tool | assistant | scoped | builder | reader | none |
|---|---|---|---|---|---|
| `update_centralu` | yes | — | — | yes | — |
| `list_sessions` | yes | yes | — | — | — |
| `read_session` | yes | yes | — | yes | — |
| `send_to_session` | yes | yes | — | — | — |
| `answer_question` | yes | — | — | — | — |
| `recall` | yes | — | — | yes | — |
| `app_guide` | yes | — | — | yes | — |
| `update_session_settings` | yes | — | — | — | — |
| `create_project` | yes | — | — | — | — |
| `add_project` | yes | — | — | — | — |
| `list_machines` | yes | — | — | — | — |
| `add_machine` | yes | — | — | — | — |
| `install_machine` | yes | — | — | — | — |
| `remove_machine` | yes | — | — | — | — |
| `reconnect_machine` | yes | — | — | — | — |
| `set_machine_auto_reconnect` | yes | — | — | — | — |
| `set_machine_autostart` | yes | — | — | — | — |
| `disconnect_machine` | yes | — | — | — | — |
| `rollback_machine` | yes | — | — | — | — |
| `uninstall_machine` | yes | — | — | — | — |
| `machine_activity` | yes | — | — | — | — |
| `list_ssh_hosts` | yes | — | — | — | — |
| `get_preferences` | yes | — | — | — | — |
| `set_preferences` | yes | — | — | — | — |
| `apply_agent_versions` | yes | — | — | — | — |
| `list_archive` | yes | — | — | — | — |
| `restore_archived` | yes | — | — | — | — |
| `archive_subagent_steps` | yes | — | — | — | — |
| `delete_session` | yes | — | — | — | — |
| `rename_session` | yes | — | — | — | — |
| `clear_background_tasks` | yes | — | — | — | — |
| `agent_status` | yes | — | — | — | — |
| `agent_models` | yes | — | — | — | — |
| `project_git_status` | yes | — | — | — | — |
| `search_project_files` | yes | — | — | — | — |
| `delete_archived` | yes | — | — | — | — |
| `delete_all_archived` | yes | — | — | — | — |
| `list_projects` | yes | — | — | — | — |
| `set_project_trust` | yes | — | — | — | — |
| `list_approval_rules` | yes | — | — | — | — |
| `remove_approval_rule` | yes | — | — | — | — |
| `list_app_grants` | yes | — | — | — | — |
| `forget_app_answer` | yes | — | — | — | — |
| `revoke_project_consent` | yes | — | — | — | — |
| `share_app` | yes | — | — | — | — |
| `list_app_versions` | yes | — | — | — | — |
| `restore_app_version` | yes | — | — | — | — |
| `restart_app` | yes | — | — | — | — |
| `check_app` | yes | — | — | — | — |
| `list_app_runs` | yes | — | — | — | — |
| `list_app_errors` | yes | — | — | — | — |
| `app_usage` | yes | — | — | — | — |
| `remove_app` | yes | — | — | — | — |
| `set_agent_limits` | yes | — | — | — | — |
| `create_session` | yes | — | — | — | — |
| `handoff_session` | yes | — | — | — | — |
| `usage_history` | yes | — | — | — | — |
| `propose_skill` | yes | — | — | — | — |
| `propose_mcp_server` | yes | — | — | — | — |
| `check` | — | — | yes | — | — |
| `create_app` | yes | — | — | — | — |
| `ask_project` | — | — | — | yes | — |
| `start_agent` | yes | — | — | yes | — |
| `agent_session` | yes | — | — | yes | — |
| `find_apps` | yes | — | — | yes | — |
| `attach_app` | yes | — | — | yes | — |
| `detach_app` | yes | — | — | yes | — |
| `mail` | yes | — | — | yes | — |
| `compact_self` | yes | — | — | yes | — |
<!-- tool-matrix:end -->

`usage_history` ([agent-host/usage.md](../agent-host/usage.md#usage-over-time-1452)) is the Assistant's alone, a rare command, and read-only: it returns token counts, cache hit
rates and the limit windows' percentages kept on this computer, with the names of sessions and projects and no conversation content.
