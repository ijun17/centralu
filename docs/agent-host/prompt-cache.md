# The prompt cache

The usage gauge also says how much of the agents' input came from the prompt cache, because a
cache rebuild is what costs: a rebuilt prompt is paid at the write price and counts toward the
limit the gauge shows. The donut's tooltip carries one line ("Cache hit 94% · last 5 h"), and the
dropdown its click opens breaks it down per tool, for the last five hours and today (the host's
local midnight): the hit rate, tokens read from cache, written to it and uncached, the rebuilds,
and the few sessions that wrote most, each opening that session.

**Counted from the sessions' own events, not from the tool's files** (the rule of [importing-sessions.md](importing-sessions.md#principle-use-only-official-apis)). The
adapters send one `request` per model request on `usage_update` (`RequestInput`): Claude per
assistant message, deduplicated by its message id because the CLI can send one response as several
messages that repeat its usage; Codex from `last` in `thread/tokenUsage/updated`, skipping a
notification whose `total` has not moved (a repeat). `tokens` stays the running reading it always
was. A Claude subagent's request counts too, carried on a `usage_update` that repeats the parent's
last reading, so the subagent's tokens never stand in for the parent's figures (#98).
`SessionManager` hands each request to `CacheLedger` (`sessions/cache-ledger.ts`), and
`agents.usage` answers with `cache: CacheStats` summed at the moment it is asked. A linked
machine's host counts its own, and the hub qualifies the session ids in its answer.

| Decision | Reasoning |
|---|---|
| Hit rate = `cacheRead / (input + cacheRead + cacheCreation)` over the window | The three input fields do not overlap (`TokenUsage`), so their sum is all the input the model read. A write counts as a miss: a window that only rebuilt reads 0%. Computed where it is shown (`@cc/core` `cacheHitRate`), from sums, so a host and a UI of different builds cannot disagree on the meaning |
| A **rebuild** is a request whose cache write is at least 50% of its whole input and at least 4,096 tokens | Normal work writes only what is new since the last request and reads the rest, a few percent; a request whose cached prefix expired or changed (another model, other tools) writes almost all of it. Claude Code's fixed prefix alone is well over 10,000 tokens, so the floor only drops small helper calls. Judged per request, not per turn: a turn of N tool calls is N+1 requests, and summing them would dilute the one rebuild under the later requests' reads. It needs no state, so interleaved subagent requests do not confuse it. `pnpm measure:tools` uses a finer rule (the input the previous request sent that this one did not read, [tool-cost.md](../tool-cost.md) §2), which needs each conversation's previous request; this rule can miss a partial rebuild that still reads half its prompt, and can count a very large tool result or a long new message early in a conversation: it is written once either way, over half of a small prompt, and its cause says "unknown", not "expired" (a 69k message in a short Codex conversation counted, #1504 review) |
| `rebuildTokens`, **what the rebuilds wrote** (#1492), per window and per session, shown next to the count ("7 rebuilds · 1M written", and "(600k)" on a session's row) | "Most cache writes" mixed the rebuilds with the steady writes every new message needs. It is the sum of the cache writes of the requests counted as rebuilds (for a tool that reports no writes, the input it did not read, which is what its rebuild paid at the write price). Kept per hour bucket in `usage_buckets.rebuild_tokens` (v63, expand only), so a restart keeps it. Hours stored before v63, and an hour a v63 host wrote and an older one then added rebuilds to (fewer tokens than 4,096 per counted rebuild), have rebuilds and no tokens: the sum is then **not known** (the field is absent from that window and session, the screen shows the count alone), never shown as smaller |
| **Writes: N% of cache cost** (#1492), beside the hit rate | The hit rate is by tokens, which hides that a write costs far more than a read: 96% by tokens was about 43% of the cost (measured on the Mac, 2026-10-23). The host weights the tokens by price **ratios** to uncached input, no money (`sessions/cache-cost.ts`): Anthropic read 0.1, five-minute write 1.25, one-hour write 2, from the API's own split (`RequestInput.cacheWrite5mTokens` / `cacheWrite1hTokens`, `cache_creation.ephemeral_5m/1h_input_tokens`; a write it did not split is priced as five minutes); Codex by model (`AgentAdapter.cacheBilling`): GPT-5.6 and later read 0.1 (0.05 on Sol) and a 30-minute write 1.25, a model named as an older one has no write price (1); a name that says no generation is priced as the current one. The share is `cacheWriteCost / (cacheReadCost + cacheWriteCost)` (`@cc/core` `cacheWriteShare`, over `CacheWindowStats`' two sums, absent from a host that predates them). Codex reports no writes, so the input it did not read stands in and the line says "uncached input"; the Codex model is the one the turns ask for, else the one the thread opened with (the adapter stamps it on each token count, `RequestInput.model`, because a session on the tool's default has none recorded and Codex's count does not say), and the ratios are as stated in the issue, not measured against a bill here |
| Codex: reads only | Codex reports the input it read from cache inside its input count and nothing about writing to it. So its hit rate is cached input over all input, its sessions are ranked by uncached input, and the screen says so in words. A Codex rebuild is a request that read less than half its input from cache (4,096 tokens or more not read): what it did not read was paid in full and is what the provider caches for the next request, the cost a Claude write stands for. codex-cli 0.160's breakdown has a `cacheWriteInputTokens` field; whether it is ever non-zero for OpenAI models, and whether `inputTokens` includes it, is not measured, so it is not read |
| Kept in the host's memory, a day at most and 50,000 requests per tool, and restored at start from the hourly buckets ([usage.md](usage.md#usage-over-time-1452)) | The windows are hours, and the figure is read only when someone looks at the gauge. Never a write per request: entries are appended in memory as requests close, old ones dropped on the next append, and the sums are taken on `agents.usage`. What an earlier run counted comes back from `usage_buckets` at start (`CacheLedger.restore`), so a restart or a swap no longer empties the figures: each bucket counts as one entry in the middle of its hour, so a window that begins inside that hour takes it or leaves it whole (an error of up to half an hour at the 5-hour edge), and `countingSince` moves back to the oldest hour restored. Rebuilds come back by cause but not with their idle times, so `expiredIdleMs` covers this run only. The gauge already asks every 5 minutes, so the tooltip costs no new question |
| The donut's own window, not the gauge's weekly one | A week does not fit in memory across restarts, and what someone acts on (an idle session whose cache expired, a model switch) shows within hours |

**Why a rebuild happened.** Each rebuild is given a likely cause, from what the host saw in that
session between the conversation's previous request and this one. The manager tells the ledger as
things happen (`CacheLedger.note`); the next request of the session's own conversation takes the
notes, rebuild or not, so a note never outlives the request it was about. The dropdown says the
causes in one line under Rebuilds ("6 rebuilds · 1M written: 3 cache expired (idle 64 min) · 1 model change ·
1 compaction · 1 unknown"; without the "written" part from a host that does not say it) and under each session it names. It is a guess from evidence, not a
report from the API, and the screen's Rebuilds tooltip says so.

| Cause, strongest evidence first | Taken from |
|---|---|
| `cold_start` first request | The session was just created (`createSession`) |
| `subagent` subagent start | A Claude subagent's first request. A subagent has its own prompt and cache, so its requests are a lane of their own (`RequestInput.agent`, the call that launched it) and never take the session's notes |
| `new_process` new process | The session's process came up again without a stated reason: woken, revived after a crash, restarted from the menu, a conversation taken over from outside. Also a conversation whose request this host has never seen with nothing noted: its process started after this host did (a restart, a host swap) |
| `model_change` model change | The model changed: the person's setting (`updateSettings`), or the tool's own switch (a refusal's fallback, `recordToolSettings`). A settings restart whose drift is the model says so too. Measured in #513's baseline: the only in-session event that rebuilt Claude's cache |
| `compaction` compaction | A `compaction` event, or `conversation_reset` (Claude Code's /clear): the next request begins with a summary or nothing the cache has seen |
| `thread_restart` thread restart | Codex's thread restarted so it took an attached or detached app. Nothing notes it since #2231 (an app changes no session's tool list); a ledger written before keeps it |
| `instructions` tools changed | The Assistant restarted for a skill change (until #2231 also for an approved MCP server, and Claude took an attached or detached app at once) |
| `launch_settings` launch settings changed | A live process restarted because its adapter launch fingerprint changed or the previous build had not recorded one (#589); an idle process restarts now, a working process after its turn; a change of the project's trust does the same for the project's live sessions (#663) and says so in the conversation |
| `expired` cache expired | Idle longer than the lifetime the API reported for this lane's last write (Claude's `cache_creation` split: `ephemeral_1h_input_tokens` or `ephemeral_5m_input_tokens`) |
| `probably_expired` probably expired | Idle more than 5 minutes when no lifetime was reported (Codex never reports one; a Claude lane that has not written yet) |
| `unknown` | None of these, including idle shorter than the reported lifetime |

How long Claude Code asks the cache to keep a write is decided per request inside the CLI (read in
CLI 2.1.289): `FORCE_PROMPT_CACHING_5M`, then `CLAUDE_CODE_PROMPT_CACHE_TTL` (or its subagent twin),
then the `promptCacheTtl` setting, an agent's frontmatter and `ENABLE_PROMPT_CACHING_1H`; otherwise
one hour for a claude.ai subscriber who is not on overage when the request's source is on a
remotely configured allowlist (`repl_main_thread*`, `sdk`, `auto_mode`, `memdir_relevance` by
default), and five minutes for everything else: API keys, overage, subagents. None of that is
visible from outside, and the allowlist can change without a release, so the host does not guess
it: it reads what the API reports each request wrote, and falls back to five minutes only when
nothing was reported. The idle time behind the rebuilds put down to expiry is shown with them
(`expiredIdleMs`, the shortest and longest in the window).

Measured with `scripts/probe-cache-causes.mts`, a probe since removed (git history keeps it) (live, haiku, CLI 2.1.289 through SDK 0.3.263, a
subscriber's login, claude.ai connectors and auto memory off, 2026-10-12): the API reported `1h` for the SDK session's writes, and `5m` under
`FORCE_PROMPT_CACHING_5M`. A switch to sonnet read 0 and wrote 23,266 of 23,268 tokens, named
`model_change`. A new session under the forced five minutes wrote all 16,794, named `cold_start`;
without it, the first request read 12,973 tokens another session had cached, so no rebuild. After
6 minutes idle on the five-minute lifetime the next request read 0 and wrote 16,959, named
`expired` (idle 362 s). Two events did not rebuild at all, so they had nothing to name: after
`/compact` the next request read the 13,074-token fixed prefix and wrote only the 2,308-token
summary, and after a restart it read 15,382 and wrote 2,124. Compaction replaces the conversation,
not the system prompt and tools in front of it, so it is named only when its summary outweighs
that prefix.

Not covered: a Codex child agent's requests (its notifications go to the parent's step list,
not through this count), the Codex request that a resumed thread may report once on resume, and
causes the host is not told about: a change the CLI makes to its own system prompt between
requests. The cache is the account's, shared across sessions, so one session can also read a
prefix another wrote and show no rebuild where one of these events would lead you to expect one.
