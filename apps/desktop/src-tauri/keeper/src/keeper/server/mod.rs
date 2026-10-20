//! The keeper process: `centralu-keeper`.
//!
//! Control socket protocol (`<data>/keeper.sock`, newline-delimited JSON, one request per
//! connection except `attach`):
//!
//! | request | answer |
//! |---|---|
//! | `{"op":"status"}` | `{"ok":true,"view":KeeperView}` — host state, the front door's port and a credential (the token for a Centralu window, the limited credential for any other process, #1405, `view.rights`), build source, the last swap |
//! | `{"op":"attach","protocol":1,"build":BuildSource?}` | `{"ok":true,"view":..,"sameBuild":bool?,"keeperSameBuild":bool?,"relaunched":bool}`, then one `{"event":"status","view":..}` line per change for as long as the connection stays open. `relaunched`: this window is the one an announced relaunch started |
//! | `{"op":"relaunching","graceSecs":n?}` | `{"ok":true,"graceSecs":n}` — the app is relaunching itself to apply an update (#352): for up to `n` s (default 60, at most 300) no window attached does not stop the keeper, whatever background mode says |
//! | `{"op":"stop"}` | `{"ok":true}`, then the host is stopped and the keeper exits |
//! | `{"op":"switch","source":BuildSource,"keeper":{"exe":path}?}` | a window's only (#1405; anyone else gets `window_only`): `{"ok":true}`, then a blue-green swap to that build (`swap.rs`), its phases pushed to attached windows in `view.swap`; with no host up, a plain start. With `keeper`, and a keeper of another build, the keeper first hands itself over to that build's keeper (`handoff/`), which then runs the swap. A keeper from verified content verifies and copies the bundle's signed content and hands over to the keeper in that copy instead (`move_to_content`); a refusal ends the swap `failed` with `refused` |
//! | `{"op":"upgrade","exe":path,"source":BuildSource}` | a window's only (#1405): `{"ok":true}`, then the keeper hands itself over to the keeper at `exe` (of build `source`), leaving the host alone (#280 step 4); from verified content, to the keeper in the verified copy of `exe`'s bundle content |
//! | `{"op":"restart"}` | `{"ok":true,"started":bool}` — Retry after the host gave up (refused during a swap) |
//! | `{"op":"settings"}` | `{"ok":true,"background":bool}` |
//! | `{"op":"set_background","on":bool}` | `{"ok":true,"background":bool}` |
//!
//! The socket is created `0600` (under `umask 077`, so there is no window before a chmod) and
//! every connection's peer uid must be ours: only this user's processes get in. Of those, only a
//! Centralu window gets the front door's token and may switch or upgrade (#1405, `window_peer.rs`:
//! the kernel's record of the peer names the window's executable); any other process gets the
//! limited credential (`limited.rs`) on `status` and `attach`, and each attached client's pushes
//! carry its own.
//!
//! The port and token in `status` are the **front door's** (#280 step 3, `front_door.rs`), not a
//! host's: the same for as long as this keeper lives, whichever host is behind them — and, since
//! step 4, across keepers too: a handoff passes the door, its token and this socket on.
//!
//! **Frozen** (step 4): while the keeper is handing itself over, it accepts nothing on this socket
//! (connections wait in the listen queue, which the next keeper inherits), answers only `status`,
//! pushes nothing to windows, and its idle rule does not run. After the commit (`handed_over`)
//! nothing in this process acts again; it exits.
//!
//! **Files.** This one: the keeper's state, the accept loop and the requests. `start.rs`: the
//! options and a fresh keeper's start. `host.rs`: the status sink and the launcher. `windows.rs`:
//! attach, detach, relaunch; `push.rs`, each window's writer. `switch.rs`: build switches, keeper handoffs and moves to verified
//! content.

mod host;
mod push;
mod start;
mod switch;
mod windows;

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Seek, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::accept::{self, AcceptErrors};
use super::children::{self, Children};
use super::{content, handoff, keys, limited, window_peer};
use super::client::{self, json_line, read_line};
use super::front_door::{self, FrontDoor};
use super::source::{self, BuildSource, Settings};
use super::swap::{self, Phase, SwapView};
use super::{
    idle_decision, idle_limit, relaunch_grace, relaunch_state, socket_path, stop_on_detach, IdleInput, KeeperInfo, KeeperView, EXIT_ALREADY_RUNNING,
    KEEPER_PROTOCOL, REATTACH_GRACE,
};

use crate::host_proc::{self, HostInfo, HostLaunch, HostStatus, LaunchError, Launcher, StatusSink, Supervisor};
use crate::os;

pub use self::start::{parse_args, run, Options};
pub(super) use self::host::{launcher, sink};
pub(super) use self::start::{log_origin, own_build, record_lock_holder};
pub(super) use self::switch::{begin_switch, host_dirs_in_use};
pub(super) use self::windows::{adopt_window, WINDOW_WRITE_TIMEOUT};
// What the moved parts name as `super::…` (the keeper module itself).
use super::{appimage, data_dir, exe, prepare_default_dir};
use self::host::*;
use self::switch::*;
use self::windows::*;

pub(super) struct State {
    pub(super) status: HostStatus,
    /// The build the current host runs or is starting.
    pub(super) source: Option<BuildSource>,
    /// The build the next launch runs. Changed by `switch`.
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
    /// The current or last swap, as the windows are shown it.
    pub(super) swap: Option<SwapView>,
    /// A swap (or a keeper handoff) is running: a second `switch` and `restart` are refused until
    /// it ends.
    pub(super) swapping: bool,
    /// The draining host's `{"drained":..}` report.
    pub(super) drained: Option<Value>,
    /// The current host's `{"swap":{"keepsAgents":..}}` report.
    pub(super) keeps_agents: Option<bool>,
    /// Until when an announced relaunch (#352) holds the keeper with no window attached. Cleared by
    /// the next attach, which is told it is the window that relaunch started.
    pub(super) relaunch_until: Option<Instant>,
    /// Until when the keeper waits for a window it closed itself (it stopped taking its status) to
    /// attach again, as for a relaunch: with no window attached, nothing stops it meanwhile. Cleared
    /// by the next attach.
    pub(super) reattach_until: Option<Instant>,
}

/// Has the child socket answer this keeper's current host (the supervisor's, its own or handed over)
/// and a swap's standby (`swap::Plan::standby`), and no other process of this user (#538).
pub(in crate::keeper) fn answer_hosts(k: &Arc<Keeper>) {
    let weak = Arc::downgrade(k);
    k.children.answer_hosts(Arc::new(move || weak.upgrade().and_then(|k| k.sup.pid())));
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
            swap: None,
            swapping: false,
            drained: None,
            keeps_agents: None,
            relaunch_until: None,
            reattach_until: None,
        }
    }

    /// Counts a window as attached and returns its id. Shared by `attach`, which adds the window to
    /// the push list once it has answered, and `add_window`.
    fn count_window(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.attached += 1;
        self.ever_attached = true;
        id
    }

    /// Counts a window another keeper handed over as attached and adds it to the push list; returns
    /// its id. A window back spends the wait for one the keeper closed.
    fn add_window(&mut self, k: &Arc<Keeper>, stream: UnixStream) -> u64 {
        let id = self.count_window();
        self.reattach_until = None;
        if let Some(w) = Window::start(k, id, stream) {
            self.subscribers.push(w);
        }
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

    /// An announced relaunch whose grace is still running.
    pub(super) fn relaunching(&self, now: Instant) -> bool {
        relaunch_state(self.relaunch_until, now).0
    }

    /// A window the keeper closed itself may still come back (`reattach_until`).
    pub(super) fn reattaching(&self, now: Instant) -> bool {
        self.reattach_until.is_some_and(|u| now < u)
    }
}

/// An attached window: its connection (passed on in a handoff) and the writer that pushes to it
/// (`push.rs`).
pub(super) struct Window {
    pub(super) id: u64,
    /// Whether the process at the other end is a Centralu window (#1405, `window_peer.rs`): only
    /// then do its views carry the front door's token. Read from the kernel when it attached, or
    /// when another keeper handed it over (the peer's record travels with the socket).
    pub(super) full: bool,
    /// Shared with the writer, not duplicated: one descriptor for both.
    pub(super) stream: Arc<UnixStream>,
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
    fn start(k: &Arc<Keeper>, id: u64, stream: UnixStream) -> Option<Window> {
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
        let full = window_peer::is_window(&stream);
        if !full {
            log(&format!("window {id} is not a Centralu window by its executable: it gets the limited credential"));
        }
        let stream = Arc::new(stream);
        match push::Pusher::start(stream.clone(), on_fail) {
            Ok(push) => Some(Window { id, full, stream, push }),
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
    /// Agents, terminals and commands the keeper holds for its hosts (step 2, `children/`).
    pub(super) children: Children,
    /// The per-build host copies and which are in use (#368, `source::Copies`).
    pub(super) copies: source::Copies,
    /// Where this keeper's own executable is: verified content (`<data>/content/<version>/`, the
    /// shell started it or a keeper from there handed over to it) or anywhere else (`content.rs`).
    pub(super) origin: content::Origin,
    pub(super) state: Mutex<State>,
    pub(super) idle: Duration,
    pub(super) started: Instant,
    /// `keeper.lock`, held (flock) for this keeper's life and passed on in a handoff (step 4).
    pub(super) lock: File,
    /// `keeper.sock`'s listener, polled so a handoff can stop accepting and pass it on.
    pub(super) listener: UnixListener,
    /// Handing over to another keeper: no accepting, no pushing, no idle rule (step 4).
    pub(super) frozen: AtomicBool,
    /// The handoff committed: this process only waits to exit and must not act on anything.
    pub(super) handed_over: AtomicBool,
    /// The accept loop has noticed `frozen` and stopped.
    pub(super) accept_parked: AtomicBool,
    /// Requests being answered right now (an attach counts until it is registered). A freeze
    /// waits for them, so no answer is half written when the socket changes hands.
    pub(super) requests: AtomicUsize,
}

/// Runs a keeper that is fully set up: the idle rule and the control socket, until it exits.
pub(super) fn serve(k: Arc<Keeper>) -> i32 {
    spawn_idle_watch(k.clone());
    accept_loop(&k);
    0
}

/// Accepts on `keeper.sock`, looking up every 100 ms for a freeze (step 4). A blocking `accept`
/// could not be stopped without closing the socket, and the socket must stay open: it is passed to
/// the next keeper with whatever is waiting in its queue.
fn accept_loop(k: &Arc<Keeper>) {
    use std::os::fd::AsRawFd;
    let _ = k.listener.set_nonblocking(true);
    let mut errors = AcceptErrors::new(log);
    loop {
        if k.handed_over.load(Ordering::SeqCst) {
            // The next keeper owns the socket now; this process is about to exit.
            thread::sleep(Duration::from_secs(3600));
            continue;
        }
        if k.frozen.load(Ordering::SeqCst) {
            k.accept_parked.store(true, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(20));
            continue;
        }
        k.accept_parked.store(false, Ordering::SeqCst);
        let mut p = libc::pollfd { fd: k.listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd.
        if unsafe { libc::poll(&mut p, 1, 100) } <= 0 {
            continue;
        }
        match k.listener.accept() {
            Ok((stream, _)) => {
                errors.accepted();
                let _ = stream.set_nonblocking(false);
                k.requests.fetch_add(1, Ordering::SeqCst);
                let guard = Request(Some(k.clone()));
                let k2 = k.clone();
                // Refused: the request (dropped with the closure) is not counted any more, and the
                // window retries on the closed connection.
                if let Err(e) = accept::spawn("keeper-request", move || handle(k2, stream, guard)) {
                    log(&format!("could not start a thread for a request: {e}"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => thread::sleep(errors.failed(&e)),
        }
    }
}

/// One request being answered; dropping it (or `done`) stops a freeze from waiting for it.
pub(super) struct Request(Option<Arc<Keeper>>);

impl Request {
    fn done(&mut self) {
        if let Some(k) = self.0.take() {
            k.requests.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        self.done();
    }
}

pub(super) fn log(msg: &str) {
    eprintln!("[keeper] {msg}");
}

impl Keeper {
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
            swap: st.swap.clone(),
            keeps_agents: st.keeps_agents,
            rights: Some(if full { "full" } else { "limited" }.to_string()),
        }
    }

    /// Pushes the current view to every attached window. Not while frozen for a handoff: the
    /// windows' sockets may be in two keepers' hands then, and two writers could interleave half
    /// lines.
    ///
    /// Only queued here: each window's writer sends it (`push.rs`), so a window that stopped
    /// reading holds up neither this lock nor the other windows (#840 item 5). One whose write fails
    /// has its connection closed (`Window::start`): that is its detach, which `watch_window` counts,
    /// and the window attaches again.
    pub(super) fn broadcast(&self, st: &mut State) {
        if self.frozen.load(Ordering::SeqCst) || self.handed_over.load(Ordering::SeqCst) {
            return;
        }
        // One line per credential: a window's carries the token, any other client's the limited one (#1405)
        let full = json_line(&json!({ "event": "status", "view": self.view(st, true) }));
        let limited = json_line(&json!({ "event": "status", "view": self.view(st, false) }));
        let phase = st.swap.as_ref().map(|s| s.phase);
        for w in &st.subscribers {
            w.push.status(if w.full { full.clone() } else { limited.clone() }, phase);
        }
    }

    /// `keeper.json`: what this keeper is and what it runs, for a person reading the data folder
    /// (the socket is how programs ask). It holds no token.
    pub(super) fn write_state_file(&self) {
        if self.handed_over.load(Ordering::SeqCst) {
            return;
        }
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
        // A keeper that has handed over owns nothing any more: stopping now would stop the next
        // keeper's host and children.
        if self.handed_over.load(Ordering::SeqCst) {
            return;
        }
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
        // A stop, unlike a host restart, ends the agents, terminals and commands. The host stops
        // them first, the way it always did; whatever it could not (a host that hung or had
        // already died) the keeper ends itself once the host is gone.
        self.children.ask_host_to_stop(children::HOST_STOP_WAIT);
        self.sup.shutdown();
        self.children.stop_all(children::STOP_GRACE);
        let _ = fs::remove_file(self.data.join("keeper.json"));
        log(&format!("stopped (pid {})", self.info.pid));
        std::process::exit(0);
    }
}

pub(super) fn spawn_idle_watch(k: Arc<Keeper>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        if k.frozen.load(Ordering::SeqCst) || k.handed_over.load(Ordering::SeqCst) {
            continue;
        }
        let reason = {
            let Ok(st) = k.state.lock() else { return };
            let now = Instant::now();
            let (relaunching, relaunch_expired) = relaunch_state(st.relaunch_until, now);
            // A window the keeper closed itself is waited for like a relaunching one.
            let relaunching = relaunching || st.reattaching(now);
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
                    relaunching,
                    relaunch_expired,
                },
                k.idle,
            )
        };
        if let Some(reason) = reason {
            k.shutdown(reason);
        }
    });
}

fn reply(stream: &mut UnixStream, v: &Value) {
    let _ = stream.write_all(&json_line(v));
}

/// Every op `handle` answers (#1405): `ops_are_listed` checks this list against the dispatcher, so a new op
/// is in `no_reply_carries_the_token_to_a_process_that_is_not_a_window` from the day it is added.
#[cfg(test)]
pub(super) const OPS: &[&str] = &["status", "attach", "children", "stop", "relaunching", "switch", "upgrade", "restart", "settings", "set_background"];

fn handle(k: Arc<Keeper>, mut stream: UnixStream, guard: Request) {
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
    if k.frozen.load(Ordering::SeqCst) && op != "status" {
        // A request that slipped in as the freeze began. The next keeper answers it once retried.
        return reply(&mut stream, &json!({ "ok": false, "error": "the keeper is handing over to a new build; try again in a moment" }));
    }
    match op {
        "status" => {
            // A window's status carries the token; anyone else's the limited credential (#1405)
            let full = window_peer::is_window(&stream);
            let view = k.state.lock().map(|st| k.view(&st, full)).ok();
            reply(&mut stream, &json!({ "ok": true, "view": view }));
        }
        "attach" => attach(k, stream, reader, &req, guard),
        // What the keeper holds (#538): read-only, for this user's tools and the integration scripts,
        // which can no longer ask the child socket
        "children" => match k.children.list(Duration::from_secs(2)) {
            Some(list) => reply(&mut stream, &json!({ "ok": true, "children": list })),
            None => reply(&mut stream, &json!({ "ok": false, "error": "the keeper has no child service" })),
        },
        "stop" => {
            reply(&mut stream, &json!({ "ok": true }));
            drop(stream);
            k.shutdown("asked to stop (Quit completely, or Restart completely)");
        }
        "relaunching" => relaunching(&k, &mut stream, &req),
        // Both start code the request names and hand it the token: a window's only (#1405)
        "switch" | "upgrade" if !window_peer::is_window(&stream) => {
            log(&format!("refused {op} to a process that is not a Centralu window"));
            reply(&mut stream, &json!({ "ok": false, "error": "window_only: only a Centralu window can switch or upgrade the keeper" }))
        }
        "switch" => switch(k, &mut stream, &req),
        "upgrade" => upgrade(k, &mut stream, &req),
        "restart" => {
            if k.state.lock().map(|st| st.swapping).unwrap_or(false) {
                return reply(&mut stream, &json!({ "ok": false, "error": "a build switch is in progress" }));
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
