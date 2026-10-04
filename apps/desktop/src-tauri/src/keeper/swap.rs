//! The blue-green host swap (#280, option C step 3).
//!
//! Replaces step 1's `switch`, which stopped the host and started the next one, cutting every
//! running turn. Now:
//!
//!   1. **Standby.** The keeper starts host B from the new build's per-build copy with `--standby`.
//!      B loads its whole bundle, finds its tools, reads the store without writing to it (refusing a
//!      store past what it can read), reports `{"standby":..}` and waits. It takes no lock, runs no
//!      migration and attaches to no agent. Host A keeps serving throughout.
//!   2. **Health.** No standby line within `STANDBY_LIMIT`, or B exits: B is stopped and its copy
//!      removed. A was never touched, so this rollback costs nothing.
//!   3. **Drain.** The front door stops handing out A (new connections wait). A is told to drain:
//!      it refuses new calls, gives running RPCs and in-process tool calls the drain bound (10 s)
//!      and cuts the rest with an error the model can retry, detaches, flushes and closes the
//!      store, lets go of the #278 lock, says `{"drained":..}` and exits.
//!   4. **Activate.** B takes the lock, runs only the migration steps the previous build can still
//!      read (heavy and breaking steps wait until the swap is over, store.ts), re-attaches, listens
//!      and prints its ready line.
//!   5. **Flip.** The front door points at B, connections still open through it are closed, clients
//!      reconnect to the same address and resync on B's new stream epoch. A's copy is removed once
//!      B is ready.
//!
//! **If B fails after A drained** (it exits or says nothing within `ACTIVATE_LIMIT` after
//! activation), A cannot come back: it has exited and released the lock. The keeper then starts
//! **A's build again** from its copy, which is kept until the swap succeeds. That build is known
//! good, and the store is still readable by it because B ran only expand steps. The person sees the
//! swap fail with the reason, and the previous build serving again; they can retry the switch.
//! Retrying B was the alternative, but a build that just failed its own start is the less likely of
//! the two to start now, and every retry is time with no host at all.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::front_door::FrontDoor;
use super::source::{self, BuildSource};
use crate::host_proc::{self, parse_ready, Adopted, HostInfo, HostOut, NextLine, Supervisor};

/// How long the old host gets for its running calls before they are cut. Measured: the longest
/// in-process call on record took 5.6 s (#280, "Measurements for option C" §2).
pub const DEFAULT_DRAIN: Duration = Duration::from_secs(10);

/// How long a standby host may take to report. Its start includes a login-shell probe for PATH
/// (about a second) and loading a 4.8 MB bundle; a minute only catches a host that is stuck.
pub const STANDBY_LIMIT: Duration = Duration::from_secs(60);

/// How long the old host may take past the drain bound to detach, close its server and store and
/// exit. Its shutdown path is budgeted at 3 s by the supervisor; past this it is stopped outright,
/// which still releases the ownership lock (an OS-held SQLite lock, #278).
pub const DRAIN_GRACE: Duration = Duration::from_secs(15);

/// How long the new host may take from activation to its ready line: the lock, the expand steps,
/// the services, listening.
pub const ACTIVATE_LIMIT: Duration = Duration::from_secs(60);

/// The drain bound: `CC_KEEPER_DRAIN_MS` (for tests), else `DEFAULT_DRAIN`.
pub fn drain_bound() -> Duration {
    std::env::var("CC_KEEPER_DRAIN_MS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_DRAIN)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// The keeper is handing itself over to the new build's keeper first (#280 step 4)
    HandingOver,
    /// Copying the build and starting the standby host
    Starting,
    /// The new host passed its own checks and is waiting
    Standby,
    /// The old host is finishing or cutting its calls
    Draining,
    /// The new host is taking over the data folder
    Activating,
    Done,
    Failed,
}

/// What the attached windows are told about a swap: pushed on every phase, and kept after it ends
/// so a window that attaches later can still see how the last one went.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapView {
    pub phase: Phase,
    pub target: BuildSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<BuildSource>,
    /// Why it failed, in words a person can act on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// It failed after the old host had drained, and the old build was started again.
    #[serde(default)]
    pub rolled_back: bool,
    /// In-process calls the old host was still running at the drain bound, and cut.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cut: Vec<String>,
    /// The keeper could not hand itself over to the new build's keeper (#280 step 4), why, in
    /// words a person can act on. The host switch went ahead under the running keeper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keeper_message: Option<String>,
    /// Seconds since the epoch.
    pub started_at: u64,
}

/// How a swap ended.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// The new host serves; the old one is gone.
    Done { cut: Vec<String> },
    /// The new host never passed its standby check. The old host was not touched and still serves.
    NotStarted(String),
    /// The new host failed after the old one had drained. The caller starts the old build again.
    FailedAfterDrain { message: String, cut: Vec<String> },
}

/// What a swap needs from the keeper, passed in so this module holds the sequence and nothing of
/// the keeper's state.
pub struct Plan<'a> {
    pub data: &'a Path,
    /// The build to swap to (its host folder in a bundle; copied here).
    pub next: BuildSource,
    /// The copy the current host runs from: never removed by a failed swap.
    pub current_copy: Option<PathBuf>,
    pub sup: &'a Supervisor,
    pub door: &'a FrontDoor,
    pub drain_bound: Duration,
    /// The environment every host the keeper starts gets, for this build.
    pub env_for: &'a (dyn Fn(&BuildSource) -> Vec<(String, String)> + Sync),
    /// The old host's `{"drained":..}` report, once its stdout has carried one.
    pub drained: &'a (dyn Fn() -> Option<Value> + Sync),
    pub progress: &'a (dyn Fn(Phase) + Sync),
    /// Records the new host as current and hands it to the supervisor.
    pub adopt: &'a (dyn Fn(Adopted, BuildSource) -> Result<(), String> + Sync),
}

pub fn run(p: &Plan) -> Outcome {
    (p.progress)(Phase::Starting);
    let copy = match source::copy_into(p.data, &p.next) {
        Ok(c) => c,
        Err(e) => return Outcome::NotStarted(format!("could not copy the new build: {e}")),
    };
    let mut next = p.next.clone();
    next.copy_dir = Some(copy.to_string_lossy().to_string());
    let forget_copy = |copy: &Path| {
        if p.current_copy.as_deref() != Some(copy) {
            let _ = std::fs::remove_dir_all(copy);
        }
    };

    // 1. Standby
    let db = p.data.join("store.db").to_string_lossy().to_string();
    let mut launch = match host_proc::bundled_launch(&copy.join("main.mjs"), &["--db".into(), db, "--standby".into()]) {
        Ok(l) => l,
        Err(host_proc::LaunchError::Fatal(m) | host_proc::LaunchError::Retry(m)) => {
            forget_copy(&copy);
            return Outcome::NotStarted(m);
        }
    };
    launch.env.extend((p.env_for)(&next));
    let mut child = match host_proc::spawn_host(&launch) {
        Ok(c) => c,
        Err(e) => {
            forget_copy(&copy);
            return Outcome::NotStarted(e);
        }
    };
    let Some(stdout) = child.stdout.take() else {
        host_proc::stop_child(&mut child);
        forget_copy(&copy);
        return Outcome::NotStarted("could not read the new host's output".into());
    };
    // A reader that can be paused, so this host can later be handed to another keeper (step 4)
    let lines = HostOut::new(stdout.into(), Vec::new());
    log(&format!("swap: standby host {} started (pid {}) from {}", next.key(), child.id(), copy.display()));

    // 2. Health
    if let Err(why) = wait_for(&lines, STANDBY_LIMIT, |v| v.get("standby").is_some()) {
        host_proc::stop_child(&mut child);
        forget_copy(&copy);
        return Outcome::NotStarted(format!("the new build did not pass its start check: {why}"));
    }
    (p.progress)(Phase::Standby);

    // 3. Drain
    (p.progress)(Phase::Draining);
    p.door.point_at(None);
    let old = p.sup.hand_over();
    let bound_ms = p.drain_bound.as_millis() as u64;
    if old.is_some() {
        if let Err(e) = p.sup.send_line(&json!({ "op": "drain", "timeoutMs": bound_ms }).to_string()) {
            log(&format!("swap: could not ask the old host to drain ({e}); stopping it"));
        }
        let deadline = Instant::now() + p.drain_bound + DRAIN_GRACE;
        while p.sup.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        if p.sup.is_running() {
            log("swap: the old host did not finish draining in time; stopping it");
            p.sup.stop_current();
            let deadline = Instant::now() + host_proc::STOP_GRACE + Duration::from_secs(2);
            while p.sup.is_running() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let cut: Vec<String> = (p.drained)()
        .and_then(|v| v.get("cut").cloned())
        .and_then(|c| serde_json::from_value(c).ok())
        .unwrap_or_default();
    // Anything still relayed to the old host: its clients reconnect and wait for the new one
    p.door.close_all();

    // 4. Activate
    (p.progress)(Phase::Activating);
    let activated = child
        .stdin
        .as_mut()
        .map(|s| s.write_all(b"{\"op\":\"activate\"}\n").and_then(|_| s.flush()))
        .unwrap_or_else(|| Err(std::io::Error::other("no stdin")));
    let ready = match activated {
        Ok(()) => wait_for(&lines, ACTIVATE_LIMIT, |v| parse_ready(v).is_some()).map(|v| parse_ready(&v)),
        Err(e) => Err(format!("could not reach the new host: {e}")),
    };
    let info: HostInfo = match ready {
        Ok(Some(info)) => info,
        Ok(None) | Err(_) => {
            let why = match ready {
                Err(w) => w,
                _ => "no ready line".into(),
            };
            host_proc::stop_child(&mut child);
            return Outcome::FailedAfterDrain { message: format!("the new build failed while taking over: {why}"), cut };
        }
    };

    // 5. Flip
    let gate = Some(lines.gate());
    let host = Adopted { child, lines: Box::new(lines), info, gate };
    if let Err(e) = (p.adopt)(host, next) {
        return Outcome::FailedAfterDrain { message: e, cut };
    }
    Outcome::Done { cut }
}

fn log(msg: &str) {
    eprintln!("[keeper] {msg}");
}

/// Where a swap reads a host's lines from: the host's stdout (`HostOut`), or a list in tests.
trait LineSource {
    fn next_line(&self, deadline: Option<Instant>) -> NextLine;
}

impl LineSource for HostOut {
    fn next_line(&self, deadline: Option<Instant>) -> NextLine {
        HostOut::next_line(self, deadline)
    }
}

/// Waits for the first JSON line `want` accepts. Other lines are logged; the last few non-JSON ones
/// become the reason if the host exits or the time runs out, since that is where a host explains
/// itself (a store too new, a missing module).
fn wait_for(lines: &impl LineSource, limit: Duration, want: impl Fn(&Value) -> bool) -> Result<Value, String> {
    let deadline = Instant::now() + limit;
    let mut said: Vec<String> = Vec::new();
    loop {
        match lines.next_line(Some(deadline)) {
            NextLine::Line(line) => {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if want(&v) {
                        return Ok(v);
                    }
                }
                eprintln!("[agent-host] {line}");
                if !line.trim().is_empty() {
                    said.push(line);
                    if said.len() > 6 {
                        said.remove(0);
                    }
                }
            }
            NextLine::Timeout => {
                return Err(last_words(&said, &format!("no answer within {}s", limit.as_secs())));
            }
            NextLine::End => return Err(last_words(&said, "it exited")),
        }
    }
}

fn last_words(said: &[String], fallback: &str) -> String {
    if said.is_empty() {
        fallback.to_string()
    } else {
        format!("{fallback}\n{}", said.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Lines a host said, then either silence (`open`) or its end.
    struct Feed {
        lines: RefCell<Vec<String>>,
        open: bool,
    }

    impl LineSource for Feed {
        fn next_line(&self, deadline: Option<Instant>) -> NextLine {
            let mut l = self.lines.borrow_mut();
            if !l.is_empty() {
                return NextLine::Line(l.remove(0));
            }
            if !self.open {
                return NextLine::End;
            }
            if let Some(d) = deadline {
                thread::sleep(d.saturating_duration_since(Instant::now()));
            }
            NextLine::Timeout
        }
    }

    fn feed(lines: &[&str]) -> Feed {
        Feed { lines: RefCell::new(lines.iter().map(|s| s.to_string()).collect()), open: false }
    }

    #[test]
    fn waits_past_other_lines_for_the_one_it_wants() {
        let rx = feed(&["[agent-host] PATH augmented", r#"{"activity":{"busy":false}}"#, r#"{"standby":{"pid":1}}"#]);
        let v = wait_for(&rx, Duration::from_secs(1), |v| v.get("standby").is_some()).unwrap();
        assert_eq!(v["standby"]["pid"], 1);
    }

    /// A store too new for the new build: the host's own sentence is the reason the person sees,
    /// and the old host was never asked to drain.
    #[test]
    fn a_host_that_exits_before_standby_is_reported_in_its_own_words() {
        let rx = feed(&["[agent-host] This data was written by a newer Centralu."]);
        let err = wait_for(&rx, Duration::from_secs(1), |v| v.get("standby").is_some()).unwrap_err();
        assert!(err.contains("it exited") && err.contains("written by a newer Centralu"), "{err}");
    }

    #[test]
    fn a_silent_host_times_out() {
        let rx = Feed { lines: RefCell::new(Vec::new()), open: true };
        let err = wait_for(&rx, Duration::from_millis(50), |_| true).unwrap_err();
        assert!(err.contains("no answer"), "{err}");
    }

    #[test]
    fn the_drain_bound_is_ten_seconds_unless_a_test_says_otherwise() {
        if std::env::var("CC_KEEPER_DRAIN_MS").is_err() {
            assert_eq!(drain_bound(), Duration::from_secs(10));
        }
    }

    #[test]
    fn a_swap_view_reads_back_as_written() {
        let v = SwapView {
            phase: Phase::Failed,
            target: BuildSource { commit: "abc".into(), ..Default::default() },
            from: None,
            message: Some("the new build did not pass its start check".into()),
            rolled_back: true,
            cut: vec!["tool app-board/add_item".into()],
            keeper_message: None,
            started_at: 1,
        };
        let text = serde_json::to_string(&v).unwrap();
        assert!(text.contains(r#""phase":"failed""#) && text.contains(r#""rolledBack":true"#), "{text}");
        assert_eq!(serde_json::from_str::<SwapView>(&text).unwrap(), v);
    }
}
