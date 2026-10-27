/**
 * The words of a handoff (#78, #102, #142) that both its starters use: the window's session menu
 * (`handoffSession` in the UI's store) and the orchestrator's handoff_session (#694, the host). Text only, no IO.
 */

/**
 * The handoff prompt (per a dogfooding request to "prompt it properly" — specifically, that the
 * language the user is using needs to carry over). Only the dying session has the full context, so
 * it is the one that writes the note.
 *
 * **The note is received as the reply, and the host places the file** (#142). The agent used to
 * write directly into `.centralu/handoff/` inside the project. Once the note moved outside the
 * user's repository (into the data folder), writing it directly would have meant granting both
 * tools more permissions — so the agent only replies, and after that turn ends the host takes
 * **the reply as recorded in the store** and places it as a file (`agents.exportHandoffNote`). This
 * also sidesteps a second dogfooding finding (a reply scraped from the on-screen conversation mixed
 * in streaming chunks and leftover output from the previous turn): it is read from the host's
 * record, not the screen, only the reply to this specific request, and only after the turn ends.
 *
 * Exported because the e2e tests identify the handoff message by this wording. Here rather than in the window's store
 * since the orchestrator's handoff_session asks for the note too (#694): one wording for both, and the host does not
 * import the UI.
 */
export function handoffPrompt(): string {
  return `You are about to be replaced by a fresh session that starts with no memory of this conversation. Write a handoff note for your successor. Your final message in this turn is the note: the app saves that message to a file and hands the file to your successor. Do not write the note to a file yourself, and do not add a preamble or a closing line around it — whatever your final message says is the note.

The note is the only thing your successor receives, so make it self-contained — never reference "the conversation above". It is saved as a file, not read as a chat message: **length is not a constraint**. Write with the density of a compaction summary, not the brevity of a reply — when in doubt, include it. If your context contains compaction summaries of earlier phases, transcribe their operational content (state, decisions, tips, conventions) rather than re-summarizing it — every re-summarization loses another layer.

Cover, in this order:
1. Project & goal — what this project is and what we are working toward.
2. Current state — what is done, what is mid-flight, and the exact state of unfinished work (files, branches, commands to resume).
3. Decisions & why — choices already made, with the reasons and evidence, so your successor does not relitigate them.
4. Next steps — what should happen next, in priority order.
5. Tips & pitfalls — this section evaporates first in handoffs, so be exhaustive, not selective: every practical trick, workaround, non-obvious command, environment quirk, mistake already made, dead end, and thing that looks right but is wrong. A tip that feels too small to mention is exactly the one to write down. If earlier parts of this conversation were compacted into summaries, carry forward every lesson those summaries mention — do not let them die with this session.
6. Working with the user — the language the user speaks, their tone, the response style they prefer, and standing instructions or conventions (build commands, commit style, things never to do).

Write the note itself in the language the user has mostly used in this conversation.`
}

/** The number of lines and characters carried in the preview — just enough to tell what happened, not enough to carry the note itself */
const PREVIEW_LINES = 10
const PREVIEW_CHARS = 700

/** The note's opening lines — blank lines are skipped (markdown notes commonly start with one) */
function notePreview(note: string): string {
  const lines: string[] = []
  for (const line of note.split('\n')) {
    if (!line.trim() && lines.length === 0) continue
    lines.push(line)
    if (lines.length >= PREVIEW_LINES) break
  }
  const head = lines.join('\n').slice(0, PREVIEW_CHARS)
  return head.length < note.trim().length ? `${head.trimEnd()}\n…` : head
}

/** A name as one JSON string on one line: JSON escapes control characters, and U+2028/U+2029 are escaped too */
function quotedName(name: string): string {
  return JSON.stringify(name)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The successor's first message (#102) — **hands over the note's location, not the note itself.**
 *
 * The full note used to be the first message verbatim. But the prompt above tells the predecessor
 * "it is a file, so length is not a constraint" — the longer the note, the more thorough it is, and
 * the more thorough it is, the larger the single message the successor received grew (measured: handing
 * a long session off to codex produced an error the moment it arrived). The file is already sitting
 * where the host placed it, so the first message only needs to point at the path — only then does
 * length stop being a constraint in fact, not merely by declaration. That location is outside the
 * project (the data folder, #142), so the path is absolute. The host opens that folder so the
 * successor can read it without asking (Claude's additional working folder — Codex does not block
 * reading it).
 *
 * Why the preview rides along too: someone who only reads the conversation record still needs to
 * know what happened. Why it **explicitly** says reading in pieces or grepping is fine: without that
 * line, the agent reads the whole file and recreates the exact problem this design just removed.
 */
export function handoffOpening(
  predecessor: string,
  note: string,
  path: string,
  /**
   * Words for the successor from whoever started the handoff, when it is not the person (#694: the orchestrator's
   * handoff_session). Said as theirs, after the note's opening, so the successor reads the note first.
   */
  extra?: { from: string; text: string },
): string {
  return [
    // The name is JSON-quoted on one line: a person or an agent can put a newline in it (#797)
    `You are taking over from a session named ${quotedName(predecessor)}. It wrote a handoff note for you and it is on disk, outside the project folder: \`${path}\`. Read it before anything else.`,
    '',
    'The note can be long. Read it in pieces (head, tail, byte offsets) or grep it for what you need — you do not have to pull the whole file into one turn.',
    '',
    'It begins:',
    '',
    notePreview(note)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n'),
    '',
    ...(extra?.text.trim()
      ? [
          `${extra.from} started this handoff and adds, for after you have read the note:`,
          '',
          extra.text
            .trim()
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
          '',
        ]
      : []),
    'Reply first with a short summary of your understanding of the current state, in the language the note uses.',
  ].join('\n')
}
