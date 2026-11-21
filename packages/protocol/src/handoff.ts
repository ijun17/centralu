// The words of a handoff, shared by the window's session menu and the Assistant's handoff_session (#694).

/**
 * The note comes back as the reply, and the host files it from its record after the turn ends (#142): writing to the
 * data folder would need more tool permissions, and the screen's copy mixes in stream chunks and the previous turn.
 * The e2e tests find the handoff message by this wording.
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

/** Enough to tell what happened, not enough to carry the note itself */
const PREVIEW_LINES = 10
const PREVIEW_CHARS = 700

/** Leading blank lines are skipped: markdown notes often start with one */
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

/** One line: JSON escapes control characters but not U+2028/U+2029 */
function quotedName(name: string): string {
  return JSON.stringify(name)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The successor's first message gives the note's path, not the note (#102): a long note as a first message broke Codex
 * (measured). The preview is for whoever reads only the conversation; "read it in pieces" stops the agent pulling in
 * the whole file again. The host opens the data folder to the successor (Claude: an added working folder; Codex
 * does not block reading it).
 */
export function handoffOpening(
  predecessor: string,
  note: string,
  path: string,
  /** From whoever started the handoff when not the person (#694), placed after the opening so the note is read first */
  extra?: { from: string; text: string },
): string {
  return [
    // A person or an agent can put a newline in a name (#797)
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
