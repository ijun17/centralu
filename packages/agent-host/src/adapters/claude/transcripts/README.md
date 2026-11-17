# Recorded Claude Code transcripts

Lines Claude Code wrote to its transcripts (`~/.claude/projects/<folder>/<session>.jsonl`), one file per CLI version,
for the tests that read a conversation back through the SDK (`history-provenance.test.ts`, #2323). The frame recordings
next door (`../recordings/`) hold the stream a session sends; this holds what the CLI kept on disk, which no stream shows:
who wrote a user line (`promptSource`, `origin`, `isMeta`, `isCompactSummary`).

Each `provenance.jsonl` gathers single lines from transcripts of real sessions (picked 2026-11-17 from one machine's
transcripts, CLI 2.1.263 to 2.1.299). Every field is as the CLI wrote it, except:

- `cwd`, `sessionId` and `gitBranch` name the fixture's folder, session and `main`;
- `parentUuid` links the lines in file order, so the SDK reads them as one conversation;
- paths under the person's home name `C:\Users\person` and the project folder `C--work-project`;
- a skill's body is cut after its first paragraphs.

| Version | Lines |
|---|---|
| 2.1.296 | a message sent through the SDK, the model's reply, a background task's notification (`promptSource: "system"`, `origin.kind: "task-notification"`), a message with `origin.kind: "human"`, a skill's body, a command's caveat, `/compact` and its output, the compaction summary, a cut-off notice, a timer's prompt, a cross-session delivery notice, a cross-session message |
| 2.1.263 | a message sent through the SDK, a subagent's notification (`promptSource: "sdk"`, `origin.kind: "task-notification"`), a cross-session message |

Add a version's file when a CLI update changes what these fields say; keep the old one, since an imported conversation
may have been written by any version.
