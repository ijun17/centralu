//! The keeper process: `centralu-keeper`.
//!
//! Control socket protocol (`<data>/keeper.sock`, newline-delimited JSON, one request per
//! connection except `attach`):
//!
//! | request | answer |
//! |---|---|
//! | `{"op":"status"}` | `{"ok":true,"view":KeeperView}` — host state, the front door's port and a credential (the token for a Centralu window, the limited credential for any other process, #1405, `view.rights`), build source |
//! | `{"op":"attach","protocol":1,"build":BuildSource?}` | `{"ok":true,"view":..,"sameBuild":bool?,"keeperSameBuild":bool?}`, then one `{"event":"status","view":..}` line per change for as long as the connection stays open. (`relaunched`, for the window an announced relaunch started, went with `relaunching` in #1895 step 4 PR 3: an earlier window reads its absence as false) |
//! | `{"op":"stop"}` | `{"ok":true}`, then the host is stopped and the keeper exits |
//! | `{"op":"stop","forUpdate":true}` | the host is stopped for an update (it lists what it ends for the next host), then `{"ok":true}`, and the keeper exits (#1895 step 3). A window's only: anyone else gets `{"ok":false,"error":"window_only: …"}` |
//! | `{"op":"switch"}`, `{"op":"upgrade"}` | `{"ok":false,"error":"gone: …"}` (#1895 step 4, PR 4): a keeper runs one build for its life. An earlier window that asks shows the refusal and offers "Restart completely", which starts a keeper of its own build |
//! | `{"op":"system_ending","cancelled":bool?}` | a window's only (#1970: one attached now, by pid and start, or one by its path; `Keeper::may_tell_system_ending`): `{"ok":true}` once the host has been told, on its stdin, that the system is ending (a shutdown, restart or sign-out; `cancelled`: that it is not after all); `{"ok":false}` when no host is up |
//! | `{"op":"restart"}` | `{"ok":true,"started":bool}` — Retry after the host gave up |
//! | `{"op":"settings"}` | `{"ok":true,"background":bool}` |
//! | `{"op":"set_background","on":bool}` | `{"ok":true,"background":bool}` |
//!
//! The socket is created `0600` (under `umask 077`, so there is no window before a chmod) and
//! every connection's peer uid must be ours: only this user's processes get in. Of those, only a
//! Centralu window gets the front door's token and may stop the keeper for an update (#1405, `window_peer.rs`:
//! the kernel's record of the peer names the window's executable); any other process gets the
//! limited credential (`limited.rs`) on `status` and `attach`, and each attached client's pushes
//! carry its own.
//!
//! The port and token in `status` are the **front door's** (#280 step 3, `front_door.rs`), not a
//! host's: the same for as long as this keeper lives, whichever host run is behind them.
//!
//! **Files.** This one: the keeper's state, the accept loop and the requests. `start.rs`: the
//! options and a fresh keeper's start. `host.rs`: the status sink and the launcher. `windows.rs`:
//! attach and detach; `push.rs`, each window's writer.

mod host;
mod push;
mod start;
mod windows;

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Seek, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::accept::{self, AcceptErrors};
use super::{content, limited, window_peer};
use super::client::{self, json_line, read_line};
use super::front_door::{self, FrontDoor};
use super::source::{self, BuildSource, Settings};
use super::{
    idle_decision, idle_limit, socket_path, stop_on_detach, IdleInput, KeeperInfo, KeeperView, EXIT_ALREADY_RUNNING,
    KEEPER_PROTOCOL, REATTACH_GRACE,
};

use crate::host_proc::{self, HostInfo, HostLaunch, HostStatus, LaunchError, Launcher, StatusSink, Supervisor};
use crate::os;

pub use self::start::{parse_args, run, Options};
pub(super) use self::host::{launcher, sink};
#[cfg(test)]
use self::start::{missing_option, own_build, EXIT_NO_TAKE_OVER, EXIT_USAGE};
pub(super) use self::windows::WINDOW_WRITE_TIMEOUT;
#[cfg(test)]
use self::windows::add_test_window;
// What the moved parts name as `super::…` (the keeper module itself).
use super::{appimage, data_dir, prepare_default_dir};
#[cfg(test)]
use self::host::*;
use self::windows::*;

pub(super) struct State {
    pub(super) status: HostStatus,
    /// The build the current host runs or is starting.
    pub(super) source: Option<BuildSource>,
    /// The build every launch runs: this keeper's own.
    pub(super) desired: BuildSource,
    /// The attached windows status is pushed to.
    pub(super) subscribers: Vec<Window>,
    pub(super) next_id: u64,
    pub(super) attached: usize,
    pub(super) ever_attached: bool,
    pub(super) last_detach: Instant,
    pub(super) busy: bool,
    pub(super) last_busy: Instant,
    pub(super) settings: Settings,
    pub(super) stopping: bool,
    /// The current host said it takes the keeper's stop lines on its stdin (`{"swap":{"stopsForUpdate":true}}`, #1895 step
    /// 3): only then is "Apply now" a stop for an update here (`view.stops_for_update`). A host of an earlier build takes
    /// them only from a window, and would be stopped as a quit
    pub(super) host_stops_for_update: bool,
    /// Until when the keeper waits for a window it closed itself (it stopped taking its status) to
    /// attach again: with no window attached, nothing stops it meanwhile. Cleared by the next attach.
    pub(super) reattach_until: Option<Instant>,
    /// Every window this keeper took by its path, by pid and start, for its life (#2119, `window_peer::judge_attaching`):
    /// one that attaches again after an install, when its path reads as no window's, is still taken
    pub(super) known_windows: Vec<window_peer::Attached>,
}

impl State {
    /// A fresh keeper's state: no host yet, the next launch runs `desired`.
    pub(super) fn new(desired: BuildSource, settings: Settings) -> State {
        let now = Instant::now();
        State {
            status: HostStatus::Starting,
            source: None,
            desired,
            subscribers: Vec::new(),
            next_id: 1,
            attached: 0,
            ever_attached: false,
            last_detach: now,
            busy: false,
            last_busy: now,
            settings,
            stopping: false,
            host_stops_for_update: false,
            reattach_until: None,
            known_windows: Vec::new(),
        }
    }

    /// Counts a window as attached and returns its id. `attach` adds the window to the push list once it has answered.
    fn count_window(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.attached += 1;
        self.ever_attached = true;
        id
    }

    /// Takes the window `id` off the push list and ends its writer.
    fn remove_window(&mut self, id: u64) {
        self.subscribers.retain(|w| {
            if w.id == id {
                w.push.close();
            }
            w.id != id
        });
    }

    /// A window the keeper closed itself may still come back (`reattach_until`).
    pub(super) fn reattaching(&self, now: Instant) -> bool {
        self.reattach_until.is_some_and(|u| now < u)
    }
}

/// An attached window: its connection and the writer that pushes to it
/// (`push.rs`).
pub(super) struct Window {
    pub(super) id: u64,
    /// Whether the process at the other end is a Centralu window (#1405, `window_peer.rs`): only
    /// then do its views carry the front door's token. Read from the kernel when it attached.
    pub(super) full: bool,
    /// For a window (`full`), its pid and start as it attached (#2117): what a stop for an update is judged by, since after
    /// an install macOS names no executable, or the old path, for it (`window_peer::judge_for_update`).
    pub(super) peer: Option<window_peer::Attached>,
    pub(super) push: Arc<push::Pusher>,
}

impl Window {
    /**
     * Starts the writer for the window `id` on `stream`. A write that fails closes the window, as
     * before (#840 item 5): it is taken off the push list and given `REATTACH_GRACE` to come back,
     * since it may only be stalled, before its connection is shut down, so its detach (which
     * `watch_window` sees as the connection ends) finds the grace already set. None, and the
     * connection shut down, when no thread could be started for it: the window attaches again.
     */
    /// `full`: whether the peer is a Centralu window (`window_peer::judge`), judged by the caller before it takes the
    /// state lock, since the judgement may run `codesign`; `peer`, its pid and start as read around that judgement
    /// (`Keeper::judge_attaching`), kept for a window only.
    fn start(k: &Arc<Keeper>, id: u64, stream: UnixStream, full: bool, peer: Option<window_peer::Attached>) -> Option<Window> {
        let k2 = k.clone();
        let on_fail = move |e: &std::io::Error| {
            log(&format!("window {id} stopped taking its status ({e}); closing its connection"));
            if let Ok(mut st) = k2.state.lock() {
                if st.subscribers.iter().any(|w| w.id == id) {
                    st.subscribers.retain(|w| w.id != id);
                    st.reattach_until = Some(Instant::now() + REATTACH_GRACE);
                }
            }
        };
        let stream = Arc::new(stream);
        match push::Pusher::start(stream.clone(), on_fail) {
            Ok(push) => {
                let peer = if full { peer } else { None };
                Some(Window { id, full, peer, push })
            }
            Err(e) => {
                log(&format!("could not start a writer for window {id} ({e}); closing its connection"));
                let _ = stream.shutdown(std::net::Shutdown::Both);
                None
            }
        }
    }
}

pub(super) struct Keeper {
    pub(super) data: PathBuf,
    pub(super) sock: PathBuf,
    pub(super) info: KeeperInfo,
    pub(super) sup: Supervisor,
    /// Where every client connects, whichever host is current (#280 step 3).
    pub(super) door: FrontDoor,
    /// The per-build host copies and which are in use (#368, `source::Copies`).
    pub(super) copies: source::Copies,
    /// Where this keeper's own executable is: verified content (`<data>/content/<version>/`, the
    /// shell started it) or anywhere else (`content.rs`).
    pub(super) origin: content::Origin,
    pub(super) state: Mutex<State>,
    pub(super) idle: Duration,
    pub(super) started: Instant,
    /// `keeper.lock`, held (flock) for this keeper's life: kept open, never read.
    pub(super) _lock: File,
    /// `keeper.sock`'s listener.
    pub(super) listener: UnixListener,
}

/// Runs a keeper that is fully set up: the idle rule and the control socket, until it exits.
pub(super) fn serve(k: Arc<Keeper>) -> i32 {
    // launchd stopping everything at a shutdown (macOS): the host is told before this process goes (#1970)
    let host = k.clone();
    os::on_system_stop(move || {
        log("stopped by the system: telling the host");
        let _ = host.sup.send_line(host_proc::SYSTEM_ENDING_LINE);
    });
    spawn_idle_watch(k.clone());
    accept_loop(&k);
    0
}

/// Accepts on `keeper.sock`, one thread per request.
fn accept_loop(k: &Arc<Keeper>) {
    let mut errors = AcceptErrors::new(log);
    loop {
        match k.listener.accept() {
            Ok((stream, _)) => {
                errors.accepted();
                let k2 = k.clone();
                // Refused: the window retries on the closed connection.
                if let Err(e) = accept::spawn("keeper-request", move || handle(k2, stream)) {
                    log(&format!("could not start a thread for a request: {e}"));
                }
            }
            Err(e) => thread::sleep(errors.failed(&e)),
        }
    }
}

pub(super) fn log(msg: &str) {
    eprintln!("[keeper] {msg}");
}

impl Keeper {
    /**
     * The window executables this keeper accepts (#1405, `window_peer::accepted_windows`): the one beside its own
     * executable, unless it runs from content, and the window of each build it names: its own (`--bundle-path`), the
     * current host's and the next launch's. Read under the state lock, which is let go
     * before anything is judged.
     */
    pub(super) fn window_exes(&self) -> Vec<PathBuf> {
        let mut bundles: Vec<String> = self.info.build.iter().filter_map(|b| b.bundle_path.clone()).collect();
        if let Ok(st) = self.state.lock() {
            bundles.extend(st.source.iter().chain(std::iter::once(&st.desired)).filter_map(|b| b.bundle_path.clone()));
        }
        let own = std::env::current_exe().ok();
        let beside = if self.origin.dir().is_some() { None } else { own.as_deref() };
        window_peer::accepted_windows(beside, &bundles)
    }

    /// Whether the peer of `stream` is a Centralu window, judged against `window_exes`; never under the state lock.
    pub(super) fn is_window(&self, stream: &UnixStream) -> bool {
        window_peer::is_window(stream, &self.window_exes())
    }

    /// The same, with why not (`window_peer::judge`).
    pub(super) fn judge_window(&self, stream: &UnixStream) -> Result<(), String> {
        window_peer::judge(stream, &self.window_exes())
    }

    /// Whether an attaching peer is a window: by its path, or as a window this keeper took by its path
    /// before (#2119, `window_peer::judge_attaching`); a window taken by its path is remembered. Never under the state
    /// lock while the path is judged, which may run `codesign`.
    /// With the window's record as it was read around the path check (`window_peer::judge_path_of`), which `Window::start`
    /// keeps, so the process remembered and the one judged are the same.
    pub(super) fn judge_attaching(&self, stream: &UnixStream) -> Result<(window_peer::Taken, Option<window_peer::Attached>), String> {
        let (by_path, peer) = window_peer::judge_path_of(|| window_peer::attached(stream), || self.judge_window(stream));
        let running = |w: &window_peer::Attached| crate::os::process_started(w.pid).ok() == Some(w.started);
        match self.state.lock() {
            Ok(mut st) => window_peer::judge_attaching(by_path, peer, &mut st.known_windows, running).map(|t| (t, peer)),
            Err(_) => by_path.map(|()| (window_peer::Taken::ByPath, peer)),
        }
    }

    /// Whether the peer may tell the host the system is ending (#1970): a window attached now, by pid and start, as for a
    /// stop for an update (after an install its path reads as no window's), or else by its path.
    pub(super) fn may_tell_system_ending(&self, stream: &UnixStream) -> bool {
        self.judge_window_for_update(stream).is_ok() || self.is_window(stream)
    }

    /// Whether the peer may stop the keeper for an update: a window attached now, by pid and start, whatever its executable
    /// reads after an install (#2117, `window_peer::judge_for_update`).
    pub(super) fn judge_window_for_update(&self, stream: &UnixStream) -> Result<(), String> {
        window_peer::judge_for_update(stream, &self.attached_windows())
    }

    /// The windows attached now, as each was judged when it attached (#2117).
    pub(super) fn attached_windows(&self) -> Vec<window_peer::Attached> {
        self.state.lock().map(|st| st.subscribers.iter().filter_map(|w| w.peer).collect()).unwrap_or_default()
    }

    /**
     * What this keeper says about itself and its host, for one client: `full` for a window, whose
     * view carries the front door's token; any other process gets the limited credential in its
     * place (#1405, `limited.rs`). Nothing else differs.
     */
    pub(super) fn view(&self, st: &State, full: bool) -> KeeperView {
        let status = match &st.status {
            HostStatus::Ready(info) if !full => HostStatus::Ready(HostInfo { port: info.port, token: limited::limited_token(&info.token) }),
            other => other.clone(),
        };
        KeeperView {
            keeper: self.info.clone(),
            status,
            host_pid: self.sup.pid(),
            source: st.source.clone(),
            background: st.settings.background,
            attached: st.attached,
            busy: st.busy,
            rights: Some(if full { "full" } else { "limited" }.to_string()),
            stops_for_update: st.host_stops_for_update,
        }
    }

    /// Pushes the current view to every attached window. Only queued here: each window's writer sends it (`push.rs`), so a window that stopped
    /// reading holds up neither this lock nor the other windows (#840 item 5). One whose write fails
    /// has its connection closed (`Window::start`): that is its detach, which `watch_window` counts,
    /// and the window attaches again.
    pub(super) fn broadcast(&self, st: &mut State) {
        // One line per credential: a window's carries the token, any other client's the limited one (#1405)
        let full = json_line(&json!({ "event": "status", "view": self.view(st, true) }));
        let limited = json_line(&json!({ "event": "status", "view": self.view(st, false) }));
        for w in &st.subscribers {
            w.push.status(if w.full { full.clone() } else { limited.clone() });
        }
    }

    /// `keeper.json`: what this keeper is and what it runs, for a person reading the data folder
    /// (the socket is how programs ask). It holds no token.
    pub(super) fn write_state_file(&self) {
        let Ok(st) = self.state.lock() else { return };
        let body = json!({
            "pid": self.info.pid,
            "protocol": self.info.protocol,
            "version": self.info.version,
            "build": self.info.build,
            "startedAt": self.info.started_at,
            "socket": self.sock,
            "background": st.settings.background,
            "host": {
                "state": match &st.status {
                    HostStatus::Starting => "starting",
                    HostStatus::Ready(_) => "ready",
                    HostStatus::Restarting { .. } => "restarting",
                    HostStatus::Failed { .. } => "failed",
                },
                "pid": self.sup.pid(),
                "source": st.source,
            },
            // The address clients use; the token is not written down
            "frontDoor": self.door.url(),
        });
        drop(st);
        let _ = source::write_private(&self.data.join("keeper.json"), &serde_json::to_vec_pretty(&body).unwrap_or_default());
    }

    /// Stops the host and ends the keeper. Idempotent.
    fn shutdown(self: &Arc<Self>, reason: &str) {
        {
            let Ok(mut st) = self.state.lock() else { return };
            if st.stopping {
                return;
            }
            st.stopping = true;
        }
        log(&format!("stopping: {reason}"));
        // Nobody new reaches a keeper on its way out. A new keeper waits for our lock, which
        // goes when this process does.
        let _ = fs::remove_file(&self.sock);
        // A stop, unlike a host restart, ends the agents, terminals and commands: the host stops them, told on its stdin,
        // and notes the person quit (#1143)
        self.sup.stop_by_line(host_proc::STOP_LINE, host_proc::STOP_WAIT);
        let _ = fs::remove_file(self.data.join("keeper.json"));
        log(&format!("stopped (pid {})", self.info.pid));
        std::process::exit(0);
    }

    /**
     * "Apply now" (#1895 step 3): stops the host for an update, so the next host continues the turns it ended and opens its
     * terminals and Run commands again, then ends the keeper. The relaunched window opens the shell, which starts the new
     * build's keeper from its verified content: no keeper ever runs a host of another build this way
     * (docs/plans/keeper-removal.md §2.3). Answers once the host is gone, so the window relaunches after it, not before.
     *
     * Returns whether it stopped: the caller then ends the process. A window's only (`window`), as `system_ending` is: any
     * other process of this user could otherwise cut every turn and have it continued as if Centralu had been updated.
     */
    pub(super) fn stop_for_update(self: &Arc<Self>, stream: &mut UnixStream, window: Result<(), String>, wait: Duration) -> bool {
        {
            let Ok(mut st) = self.state.lock() else { return false };
            if let Some(why) = stop_for_update_refusal(&st, window.is_ok()) {
                drop(st);
                if let Err(not) = &window {
                    log(&format!("refused a stop for an update to a process that is not a Centralu window: {not}"));
                }
                reply(stream, &json!({ "ok": false, "error": why }));
                return false;
            }
            st.stopping = true;
        }
        log("stopping for an update: the host lists what it ends for the next one");
        let _ = fs::remove_file(&self.sock);
        self.sup.stop_for_update(wait);
        let _ = fs::remove_file(self.data.join("keeper.json"));
        reply(stream, &json!({ "ok": true }));
        log(&format!("stopped for an update (pid {})", self.info.pid));
        true
    }
}

/// The refusal of a stop for an update to a process that is not a Centralu window attached to this keeper, in words true
/// for whoever asks (#2119 review): any other process (an agent's shell) gets it, and so does the person's own window
/// when this keeper does not know it (one started after the install, or a window whose attach could not be taken again);
/// for that window, quitting and reopening runs the installed build, which is the update
pub(super) const NOT_A_WINDOW: &str = "window_only: only a Centralu window attached to this keeper can stop it for an update; if this is Centralu's window and an update was installed while it ran, quit Centralu and open it again to finish the update";

/// Why this keeper cannot stop for an update now, or None (#1895 step 3), each in words the window shows after "Not
/// relaunched:". Nothing is stopped when it cannot: the window says why and stays
pub(super) fn stop_for_update_refusal(st: &State, window: bool) -> Option<&'static str> {
    if !window {
        Some(NOT_A_WINDOW)
    } else if st.stopping {
        Some("Centralu is already stopping (a quit, or another update); open it again once it has")
    } else if !st.host_stops_for_update {
        Some("the agent host is not up to be stopped for the update (it is starting or restarting); try again in a moment")
    } else {
        None
    }
}

pub(super) fn spawn_idle_watch(k: Arc<Keeper>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let reason = {
            let Ok(st) = k.state.lock() else { return };
            let now = Instant::now();
            idle_decision(
                IdleInput {
                    background: st.settings.background,
                    attached: st.attached,
                    ever_attached: st.ever_attached,
                    busy: st.busy,
                    stopping: st.stopping,
                    since_start: now.duration_since(k.started),
                    since_detach: now.duration_since(st.last_detach),
                    since_busy: now.duration_since(st.last_busy),
                    window_expected: st.reattaching(now),
                },
                k.idle,
            )
        };
        if let Some(reason) = reason {
            k.shutdown(reason);
        }
    });
}

/// Ends the keeper once it has stopped for an update. A test runs the dispatcher inside its own binary: there this panics on the
/// request's thread instead, so a stop that should not have happened fails the test rather than end the run as if it passed
pub(in crate::keeper) fn exit_after_stop() -> ! {
    #[cfg(test)]
    panic!("the keeper would exit here");
    #[cfg(not(test))]
    std::process::exit(0)
}

/// The refusal of a restart by a keeper on its way out
pub(super) const KEEPER_STOPPING: &str = "the keeper is stopping";
/// The answer to `switch` and `upgrade` (#1895 step 4, PR 4), in words an earlier window shows as it is
pub(super) const GONE: &str = "gone: this keeper runs one build for its whole life and no longer switches builds; quit Centralu completely and open it again to run another build";

fn reply(stream: &mut UnixStream, v: &Value) {
    let _ = stream.write_all(&json_line(v));
}

/// Every op `handle` answers (#1405): `ops_are_listed` checks this list against the dispatcher, so a new op
/// is in `no_reply_carries_the_token_to_a_process_that_is_not_a_window` from the day it is added.
#[cfg(test)]
pub(super) const OPS: &[&str] = &["status", "attach", "children", "stop", "system_ending", "switch", "upgrade", "restart", "settings", "set_background"];

fn handle(k: Arc<Keeper>, mut stream: UnixStream) {
    if !accept::from_this_user(&stream, log) {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(WINDOW_WRITE_TIMEOUT));
    let Ok(read_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let req: Value = match read_line(&mut reader) {
        Ok(Some(l)) => match serde_json::from_str(&l) {
            Ok(v) => v,
            Err(e) => return reply(&mut stream, &json!({ "ok": false, "error": format!("not JSON: {e}") })),
        },
        _ => return,
    };
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    match op {
        "status" => {
            // A window's status carries the token; anyone else's the limited credential (#1405)
            let full = k.is_window(&stream);
            let view = k.state.lock().map(|st| k.view(&st, full)).ok();
            reply(&mut stream, &json!({ "ok": true, "view": view }));
        }
        "attach" => attach(k, stream, reader, &req),
        // What the keeper holds (#538): nothing since #1895 step 4, said so to the tools and hosts that still ask
        "children" => reply(&mut stream, &json!({ "ok": true, "children": [] })),
        "stop" if req.get("forUpdate").and_then(Value::as_bool) == Some(true) => {
            let window = k.judge_window_for_update(&stream);
            if k.stop_for_update(&mut stream, window, host_proc::STOP_FOR_UPDATE_WAIT) {
                drop(stream);
                exit_after_stop();
            }
        }
        "stop" => {
            reply(&mut stream, &json!({ "ok": true }));
            drop(stream);
            k.shutdown("asked to stop (Quit completely, or Restart completely)");
        }
        // The window heard the system end (macOS: the workspace's power-off notice). A process that is not a window could make a
        // false mark, so it is the window's alone
        "system_ending" if !k.may_tell_system_ending(&stream) => {
            log("refused system_ending to a process that is not a Centralu window");
            reply(&mut stream, &json!({ "ok": false, "error": "window_only: only a Centralu window can tell the host the system is ending" }))
        }
        "system_ending" => {
            let cancelled = req.get("cancelled").and_then(Value::as_bool) == Some(true);
            let line = if cancelled { host_proc::SYSTEM_ENDING_CANCELLED_LINE } else { host_proc::SYSTEM_ENDING_LINE };
            match k.sup.send_line(line) {
                Ok(()) => reply(&mut stream, &json!({ "ok": true })),
                Err(e) => reply(&mut stream, &json!({ "ok": false, "error": format!("the host was not told: {e}") })),
            }
        }
        // The swap and the move to another build's keeper went in #1895 step 4, PR 4: an earlier window that asks shows this and
        // offers "Restart completely"
        "switch" | "upgrade" => reply(&mut stream, &json!({ "ok": false, "error": GONE })),
        "restart" => {
            if k.state.lock().map(|st| st.stopping).unwrap_or(true) {
                return reply(&mut stream, &json!({ "ok": false, "error": KEEPER_STOPPING }));
            }
            let started = k.sup.restart(sink(&k), launcher(&k));
            reply(&mut stream, &json!({ "ok": true, "started": started }));
        }
        "settings" => {
            let background = k.state.lock().map(|st| st.settings.background).unwrap_or(false);
            reply(&mut stream, &json!({ "ok": true, "background": background }));
        }
        "set_background" => {
            let Some(on) = req.get("on").and_then(Value::as_bool) else {
                return reply(&mut stream, &json!({ "ok": false, "error": "set_background needs on: true|false" }));
            };
            if let Err(e) = source::save_background(&k.data, on) {
                return reply(&mut stream, &json!({ "ok": false, "error": format!("could not save the setting: {e}") }));
            }
            if let Ok(mut st) = k.state.lock() {
                st.settings.background = on;
                k.broadcast(&mut st);
            }
            k.write_state_file();
            log(&format!("background mode {}", if on { "on" } else { "off" }));
            reply(&mut stream, &json!({ "ok": true, "background": on }));
        }
        _ => reply(&mut stream, &json!({ "ok": false, "error": format!("unknown op {op:?}") })),
    }
}

#[cfg(test)]
mod tests;
