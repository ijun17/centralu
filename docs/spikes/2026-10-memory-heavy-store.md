# What the window costs in memory against a heavy store (2026-10-06)

> Measured for #364 ("Performance") after the memory fixes #393–#397 merged. The owner's app on macOS uses about
> 750 MB for the window (WebKit WebContent 506 MB, the window process 169 MB, GPU and network). This record
> reproduces that kind of load on a seeded store, in Playwright's WebKit and Chromium, and finds where the memory
> goes.
>
> **Short version.** What the window holds is small: in Chromium the JS heap after a collection is 15–19 MB with a
> 150k-row store open, the content process settles near 90 MB, and the virtual list keeps under 1,000 DOM nodes.
> What costs is (1) **a once-a-second repaint while a session works**: the elapsed-time counter keeps WebKit's GPU
> process ~90 MB above what it needs for the whole turn (190 MB instead of ~100; slowing that one timer removes it,
> the spinning orbit does not cause it), (2) **the grid**: +145 MB in the GPU process for six idle panels, and (3)
> **WebKit keeping the high-water mark of a burst of work**: scrolling back through history or streaming lifts the
> WebContent process from ~115 MB to ~250 MB, and it often stays there, while Chromium shows the same work leaves no
> live state. #393 does not move these numbers, and was not expected to (§5).

## 1. Method

**The store.** `e2e/fixtures/heavy-store.ts` seeds a fresh data folder: real `Store` rows, real image files under
`attachments/`, deterministic from one seed (`pnpm seed:store <folder> --profile owner`). It is based on
`measure/seed.mts` by GyuHo123 in #400 (one project, one long session, five short ones) and shaped after the owner's
real store, whose ~20 sessions hold about 61k tool calls, 61k tool results, 20k assistant texts, 10k reasoning rows
and a few dozen images. A turn is a person's message, then mostly tool calls with their results, a text every few
calls and some reasoning; tool output follows each tool's usual size (a Read long, an Edit short, capped at 50 KB),
and the card's `summary` is its first 300 characters as the Claude adapter writes it. Some calls launch a subagent
(~80 steps each, in their own table), some Bash calls ask for approval, long sessions are compacted now and then,
and a saved grid and an app-run log are written.

| Profile | Sessions | Rows | Calls / results | Texts | Reasoning | Person | Images | Subagent steps | Tool output | Store on disk | Seeding |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `small` (≈ #400's) | 6 | 3,012 | 1,170 each | 392 | 168 | 82 | 2 (1.1 MB) | 1,520 in 6 launches | 4.5 MB | 14 MB | 0.6 s |
| `owner` (measured here) | 24 in 4 projects, longest 20,000 | 148,589 | 58,218 each | 18,518 | 8,750 | 3,488 | 40 (22 MB) | 45,398 in 234 launches | 225 MB | 596 MB | 15 s |
| `stress` | 60 in 8 projects, two of 50,000 | 352,097 | 137,862 each | 43,885 | 20,698 | 8,486 | 120 (61 MB) | 122,136 | 502 MB | 1.35 GB | 40 s |

Seed 1 throughout. The rows are the same for the same seed and folder; tool inputs name files under the folder, so
another folder moves the counts by a fraction of a percent. The owner store also has 659 approvals, 39 compaction
markers, a six-panel grid and 400 app runs. Its tool output is kept whole (#221), so it is larger on disk than the real store was on 2026-09-30
(236 MB, outputs then cut at 300 characters). The window never receives that output: a history page carries cards.

**The run.** `pnpm perf:memory` (`e2e/perf-memory.mts`) seeds a store per engine in a temporary data folder, starts
a real host on it from source (`CC_DATA_DIR`, `HOME` and `--db` all in that folder), builds the web UI for
production against that host and serves it, and drives it in Playwright's headless browser at 1440×900, device
scale 2:

| Step | What happens before the sample |
|---|---|
| blank | an empty page of the same origin: the engine's floor |
| shell | the app up, nothing opened (only in the anatomy runs) |
| long | the 20,000-row session opened (its last page has three screenshots) |
| scrolled | 20 history pages read back by scrolling up (2,200 rows received) |
| grid | the saved grid: six session panels, none working |
| switched | focus moved through ten sessions, then back to the long one |
| stream-0s … stream-300s | five minutes of a synthetic turn loop into the long session, watched from its end |
| stream-settled | 30 s after the stream stops |

The stream is injected into the page's socket through Playwright's `routeWebSocket`, in the host's own envelope,
with the host's later event numbers shifted past the injected ones, so the window cannot tell it from a host. Per
turn: the person's message, `state_change` working, a background task; then twelve steps of reasoning (10 deltas),
text (40 deltas at ~45 ms, about a model's pace), a tool call with 20 lines of live output (one step in the middle is
an `Agent` call with 20 subagent steps instead) and its result; a 1440×900 screenshot every other turn; `usage_update`
after each step; the turn ends with `turn_complete` and idle.

Each sample waits 10 s after the step, then takes three readings a second apart and keeps the median: the
physical footprint of every browser process from `top` (the number Activity Monitor calls Memory), RSS from `ps`,
DOM nodes, conversation rows the virtual list has mounted, running animations; in Chromium also the JS heap over CDP,
before and after a forced collection, and the content process's footprint after that collection. WebKit offers no
way to force a collection from Playwright, so its numbers are as found.

Only processes the script started are measured. WebKit's helpers are launchd XPC services, not children of the
browser, so they are the WebKit processes that appeared after the launch; the runs held the e2e lock so no other
Playwright WebKit was starting. Nothing asks the OS for a permission: no `footprint`, no `vmmap`, no screen.

Machine: Mac16,8 (M4 Pro, 24 GB), macOS 27.0.1. Playwright 1.62.1: WebKit 26.5, Chromium 151.0.7922.34.
`main` is 920d2553 (#393 merged); `pre-393` is bda7de5c, the commit before it, built from the same host.

## 2. Results on main

WebKit, median of three runs (range in brackets where the runs disagree); footprint in MB.

| Step | WebContent | GPU | UI process | Network | All processes | DOM nodes | Rows mounted |
|---|---:|---:|---:|---:|---:|---:|---:|
| blank | 13 | 31 | 20 | 6 | 70 | 6 | 0 |
| long | 118 (116–120) | 72 | 23 | 6 | 220 | 871 | 16 |
| scrolled | 248 (133–253) | 74 | 24 | 6 | 352 (236–359) | 975 | 27 |
| grid | 253 (137–262) | 225 | 25 | 6 | 509 (391–520) | 2,227 | 90 |
| switched | 142 (131–254) | 84 | 25 | 6 | 257 (245–370) | 906 | 19 |
| stream-0s | 141 (130–254) | 72 | 25 | 6 | 243 (232–358) | 871 | 16 |
| stream-60s | 265 (156–304) | 193 | 25 | 6 | 489 (376–547) | 703 | 17 |
| stream-150s | 259 (151–289) | 192 | 25 | 6 | 482 (369–514) | 724 | 18 |
| stream-300s | 257 (146–282) | 190 | 25 | 6 | 483 (362–504) | 707 | 17 |
| stream-settled | 179 (146–256) | 68 | 25 | 6 | 281 (243–355) | 705 | 17 |

Chromium, one run; "after GC" is after `HeapProfiler.collectGarbage`.

| Step | Renderer | Renderer after GC | GPU | Browser | Other | All | JS heap | JS heap after GC | DOM nodes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| blank | 29 | 29 | 36 | 63 | 40 | 192 | 1.2 | 0.8 | 6 |
| long | 93 | 73 | 55 | 68 | 44 | 284 | 33 | 14 | 871 |
| scrolled | 149 | 94 | 61 | 70 | 44 | 348 | 30 | 17 | 1,023 |
| grid | 99 | 86 | 188 | 65 | 42 | 418 | 24 | 18 | 2,230 |
| switched | 110 | 84 | 63 | 65 | 42 | 304 | 24 | 16 | 906 |
| stream-0s | 83 | 83 | 61 | 64 | 42 | 274 | 16 | 16 | 871 |
| stream-60s | 129 | 91 | 188 | 65 | 42 | 448 | 32 | 18 | 703 |
| stream-150s | 150 | 88 | 184 | 65 | 42 | 465 | 31 | 17 | 720 |
| stream-300s | 159 | 88 | 187 | 65 | 42 | 477 | 49 | 19 | 705 |
| stream-settled | 88 | 88 | 71 | 65 | 42 | 290 | 19 | 19 | 703 |

The virtual list does its job: with a 20,000-row session open, 16–30 rows are mounted and the page has under
1,000 DOM nodes; six grid panels have 2,230. The conversation DOM is not where the memory is.

## 3. Where it goes

**The app itself.** WebKit with DPR 2: blank 13 MB, the app up with nothing open 58 MB, the long session open 102 MB
(WebContent). The ~45 MB for the shell is code (one 1.3 MB JavaScript chunk with React, the Markdown stack and xterm in it) and
the first render; the session adds ~45 MB, three decoded screenshots among it.
Chromium's JS heap after a collection is 11 MB for the shell and 14 MB with the session.

**What each part of the stream costs.** Two-minute streams from `long`, with parts of the turn left out (the
`--stream-parts` option); footprint in MB at the end of the stream and 30 s after it. "Working" is the session's
state going to working and back each turn, with `usage_update`s; every other row includes it.

| Stream (WebKit) | Runs | WebContent: before → end → settled | GPU: end → settled | Animations running |
|---|---:|---|---|---|
| a background task only, never working | 1 | 106 → 107 → 106 | 76 → 72 | none |
| working only | 2 | 94 / 108 → 103 / 98 → 105 / 98 | 189 / 191 → 72 | orbit, pulse |
| working only, reduced motion | 1 | 109 → 116 → 117 | 191 → 72 | pulse |
| working only, every animation off | 1 | 110 → 118 → 120 | 190 → 71 | none |
| **working only, elapsed counter ticking every 10 min instead of every second** | 1 | 106 → 109 → 98 | **106 → 72** | orbit, pulse |
| **the same, every animation off** | 1 | 114 → 120 → 120 | **99 → 72** | none |
| + text and reasoning deltas | 3 | 106 → 122 (109–212) → 119 (108–122) | 187 → 65 | |
| + text and reasoning, animations off | 1 | 112 → 217 → 217 | 186 → 65 | none |
| + tool calls, live output, a subagent card | 3 | 107 → 164 (142–165) → 164 (142–164) | 185 → 63 | |
| + live screenshots | 1 | 99 → 114 → 103 | 212 → 71 | |
| everything | 1 | 109 → 232 → 125 | 229 → 62 | |
| everything, animations off | 1 | 108 → 223 → 223 | 208 → 64 | none |

| Stream (Chromium) | Renderer after GC: before → end → settled | GPU: end → settled | JS heap after GC |
|---|---|---|---|
| working only | 73 → 67 → 67 | 216–238 → 65 | 14 |
| working only, reduced motion | 73 → 67 → 67 | 202–235 → 65 | 15 |
| + text and reasoning | 73 → 71 → 71 | 181 → 66 | 15–16 |
| + tool calls, live output, a subagent card | 73 → 71 → 71 | 212–243 → 67 | 15 |

Three things follow. The GPU growth while working is not the orbit or the pulsing dot: it stays with every
animation off and goes when only `ActivityRow`'s one-second `setInterval` (the elapsed time in the activity row,
`features/session/SessionView.tsx`) is slowed down, animations on or off (a copy of main with that one interval
set to ten minutes, built with `--ui-root`). A repaint every second keeps the window's
backing stores live; with nothing repainting, WebKit lets them go within seconds (the settled column). Streamed
text, tool output and images add WebContent memory in WebKit that Chromium shows to be garbage, not state: its
renderer after a collection and its JS heap do not move. And in WebKit that garbage's high-water mark is often kept
(the "settled" column of the text and tool rows).

**What pixels cost.** At device scale 1 instead of 2, WebKit's GPU process holds 30 MB instead of 72 MB with the long
session open; the grid holds 147 MB instead of 216 MB. WebContent barely moves (95 vs 102 MB). So the focus view's
GPU memory is the window's backing store and scales with pixels, while most of the grid's is not.

**The grid.** Six idle panels: WebKit's GPU process 216–225 MB against 72 MB for the focus view, Chromium's 185–188
against 55. Nothing animates in the grid sample, and with every animation off it is the same (216 MB). At device
scale 1 it is still 147 MB. The panels' own layers (each panel a scroll container with an absolutely positioned
virtual list, a sticky banner, rounded clipping) are the likely cost; this run cannot list layers, so that is the
next measurement (WebKit's layer borders, or Chromium's Layers panel, by hand).

**The bursts WebKit keeps.** In every WebKit run the WebContent process is ~115 MB with the long session open, then
some step lifts it by ~130 MB: scrolling back through 20 pages in four of six runs, the first minute of streaming in
another. Afterwards it is either back near 140–180 MB or still at ~250 MB minutes later; the runs split between
the two. Chromium, doing the same work, ends every step at 84–94 MB after a collection with a 15–19 MB JS heap: the
work makes garbage, not state. WebKit's allocator and JS heap keep the high-water mark; WKWebView in the app will do
the same, and over a day of streaming and scrolling the high-water mark is what the owner sees.

## 4. What dominates

1. **The GPU process while a session works.** +120 MB in WebKit (+130–180 MB in Chromium) for as long as a session
   is working, ~90 MB of it from the activity row's one-second repaint; back to ~70 MB seconds after the turn ends. The
   owner's sessions work most of the day, and several working sessions share the one window.
2. **The WebContent high-water mark.** ~130 MB above the settled size after a burst of history reading or streaming,
   often not returned in WebKit, though Chromium shows nothing of it is live.
3. **The grid's compositing.** +145 MB GPU for six idle panels, mostly independent of device scale.
4. **The app's floor.** ~45 MB of WebContent for the shell before any session opens.

The window process in the owner's app (169 MB) is Tauri's UI process, which hosts the Rust shell as well as WebKit's
UI side; Playwright's WebKit UI process is 20–25 MB and does not stand in for it.

## 5. Before and after #393

| Step (WebKit, median of 3) | pre-393 | main |
|---|---:|---:|
| long | 117 | 118 |
| scrolled | 227 | 248 |
| grid | 257 | 253 |
| switched | 178 | 142 |
| stream-300s | 170 | 257 |
| stream-settled | 156 | 179 |

| Step (Chromium, renderer after GC) | pre-393 | main |
|---|---:|---:|
| long | 75 | 73 |
| scrolled | 98 | 94 |
| grid | 94 | 86 |
| switched | 86 | 84 |
| stream-settled | 90 | 88 |

No difference beyond WebKit's run-to-run spread (each WebKit cell spans 120+ MB across the three runs). That is
expected: #393 trims conversations that keep receiving events while off screen and per-session state of deleted
sessions, which grows over days; this scenario streams only into the focused session and runs for minutes. A test
of #393 would be a worker streaming in the background for hours, with the JS heap after GC as the number.

## 6. Caveats

- **Playwright's WebKit is not the WKWebView in the Tauri shell.** It is WebKit 26.5 built by Playwright, headless,
  with its own UI process; the app uses the system WebKit in a real window. Absolute numbers will differ;
  directions (what grows, what returns) are what this record is for. Not exercised: the packaged app's WKWebView.
- Headless rendering on screen-less surfaces; a visible window on a real display, a second monitor or a larger
  window costs more backing store.
- The host runs from source under `tsx` (~300 MB at start, ~160 MB later), not the bundled host the app runs; its
  number is printed but not discussed here.
- WebKit's numbers include garbage it has not collected; with no way to force a collection they spread widely
  between runs. Three runs per build is the least that showed the bimodal pattern.
- The fixture has no app views (iframes), terminals, file trees or git panels, and no inline app screens. The owner's
  window has those; each is its own cost.
- One machine, one sitting.

## 7. Targets for #364

In order of measured size. "Expected" is what the numbers above support at 1440×900, device scale 2, in WebKit;
each change still needs its own before and after, which `pnpm perf:memory` gives.

1. **Do not repaint every second while a session works.** `ActivityRow`'s elapsed counter ticks at 1 Hz. Slowing it
   (a 10-minute interval, as a stand-in) kept the GPU process at 99–106 MB through working turns instead of 190 MB,
   with the orbit and the pulse still running. Options: show the elapsed time in coarser steps after the first
   minute (every 10 s, then every minute), skip the tick while the window is hidden or unfocused, or draw it with a
   CSS counter that does not repaint the row. **Expected: ~85–90 MB GPU back for the whole of every working
   stretch that prints nothing** (long tool calls, waiting on a subagent, thinking); streamed text still repaints, so
   less while text arrives. Check the other once-a-second timers the same way (`Inbox`'s `setNow`).
2. **Bring the grid's GPU cost down.** +145 MB for six idle panels. First list the layers each panel creates and
   their sizes (WebKit layer borders by hand), then remove what does not need its own layer (the panel's scroll
   container is enough). **Expected: up to ~100 MB in the grid**; unknown until the layers are listed.
3. **Make less garbage per streamed event and per history page.** Every `message_delta` re-parses the whole
   message's Markdown (`Markdown` is memoised on the full text, so each delta parses it from the start with
   remark-gfm), and every delta copies the whole `chat` array (`items.slice` for text, `items.map` for tool output,
   in `appendChat`; 2,200 rows after scrolling back). Chromium shows none of it survives a collection; WebKit keeps
   the high-water mark. Options: render the streaming message as plain text and parse Markdown when it ends (or parse only its last
   block), update the last row without copying the array, coalesce deltas per animation frame. **Expected: most of
   the ~130 MB WebContent rise in WebKit after streaming or history reading**, an estimate, since WebKit's heap cannot
   be read from Playwright.
4. **Shrink the shell.** ~45 MB of WebContent and an 11 MB JS heap before any session opens, from one 1.3 MB
   JavaScript chunk. xterm (terminals) and the Markdown stack are loaded up front; splitting them out until first
   use is the obvious cut. **Expected: 10–20 MB**, to be measured.
5. **Images** (named in #364 and #392): live screenshots added 7–15 MB that came back; three screenshots on the
   long session's first page are inside its ~45 MB. Not a top target on these numbers. If revisited, hand the `<img>`
   a blob URL made once per image instead of a new `data:` string per render.

Not targets on these numbers: the conversation DOM (virtualised: 16–30 rows, under 1,000 nodes for one session) and
the window's JS state (15–19 MB after a collection with a 150k-row store).

## 8. Reproduce

```bash
until mkdir /tmp/centralu-e2e.lock 2>/dev/null; do sleep 20; done
pnpm perf:memory --profile owner --engines webkit,chromium --out /tmp/main.json     # ~20 min
pnpm perf:memory --engines webkit --steps shell,long,stream --stream-minutes 2 --stream-parts working   # one part
pnpm perf:memory --engines webkit --steps blank,shell,long,grid --dpr 1
pnpm perf:memory --ui-root <checkout of another commit> --label other               # the UI of another build
rmdir /tmp/centralu-e2e.lock
```

`--reduced-motion` and `--freeze-animations` run the same with the app's motion reduced or every animation off.
