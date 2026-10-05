//! The keeper process: `centralu --keeper`.
//!
//! Control socket protocol (`<data>/keeper.sock`, newline-delimited JSON, one request per
//! connection except `attach`):
//!
//! | request | answer |
//! |---|---|
//! | `{"op":"status"}` | `{"ok":true,"view":KeeperView}` — host state, the front door's port and token, build source, the last swap |
//! | `{"op":"attach","protocol":1,"build":BuildSource?}` | `{"ok":true,"view":..,"sameBuild":bool?,"keeperSameBuild":bool?,"relaunched":bool}`, then one `{"event":"status","view":..}` line per change for as long as the connection stays open. `relaunched`: this window is the one an announced relaunch started |
//! | `{"op":"relaunching","graceSecs":n?}` | `{"ok":true,"graceSecs":n}` — the app is relaunching itself to apply an update (#352): for up to `n` s (default 60, at most 300) no window attached does not stop the keeper, whatever background mode says |
//! | `{"op":"stop"}` | `{"ok":true}`, then the host is stopped and the keeper exits |
//! | `{"op":"switch","source":BuildSource,"keeper":{"exe":path}?}` | `{"ok":true}`, then a blue-green swap to that build (`swap.rs`), its phases pushed to attached windows in `view.swap`; with no host up, a plain start. With `keeper`, and a keeper of another build, the keeper first hands itself over to that build's keeper (`handoff/`), which then runs the swap |
//! | `{"op":"upgrade","exe":path,"source":BuildSource}` | `{"ok":true}`, then the keeper hands itself over to the keeper at `exe` (of build `source`), leaving the host alone (#280 step 4) |
//! | `{"op":"restart"}` | `{"ok":true,"started":bool}` — Retry after the host gave up (refused during a swap) |
//! | `{"op":"settings"}` | `{"ok":true,"background":bool}` |
//! | `{"op":"set_background","on":bool}` | `{"ok":true,"background":bool}` |
//!
//! The socket is created `0600` (under `umask 077`, so there is no window before a chmod) and
//! every connection's peer uid must be ours: only this user's processes can attach, read the
//! host token, or stop and switch the host. That is the same trust as the token itself, which
//! only this user can read today.
//!
//! The port and token in `status` are the **front door's** (#280 step 3, `front_door.rs`), not a
//! host's: the same for as long as this keeper lives, whichever host is behind them — and, since
//! step 4, across keepers too: a handoff passes the door, its token and this socket on.
//!
//! **Frozen** (step 4): while the keeper is handing itself over, it accepts nothing on this socket
//! (connections wait in the listen queue, which the next keeper inherits), answers only `status`,
//! pushes nothing to windows, and its idle rule does not run. After the commit (`handed_over`)
//! nothing in this process acts again; it exits.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Seek, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::children::{self, Children};
use super::handoff;
use super::client::{self, read_line};
use super::front_door::{self, FrontDoor};
use super::source::{self, BuildSource, Settings};
use super::swap::{self, Phase, SwapView};
use super::{
    idle_decision, idle_limit, relaunch_grace, relaunch_state, socket_path, stop_on_detach, sys, IdleInput, KeeperInfo, KeeperView, EXIT_ALREADY_RUNNING,
    KEEPER_PROTOCOL,
};
use crate::host_proc::{self, HostInfo, HostLaunch, HostStatus, LaunchError, Launcher, StatusSink, Supervisor};

/// Command-line options. The app passes all of them; a person starting a keeper by hand can
/// leave them out (it then runs the host from source, as a debug build would).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Options {
    pub data_dir: Option<PathBuf>,
    pub host_source: Option<PathBuf>,
    pub bundle_path: Option<String>,
    pub app_version: Option<String>,
    /// Started by another keeper to take over from it (#280 step 4): the handoff channel's
    /// descriptor, inherited from that keeper.
    pub take_over_fd: Option<i32>,
}

pub fn parse_args(args: &[String]) -> Options {
    let mut o = Options::default();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--data-dir" => o.data_dir = it.next().map(PathBuf::from),
            "--host-source" => o.host_source = it.next().map(PathBuf::from),
            "--bundle-path" => o.bundle_path = it.next().cloned(),
            "--app-version" => o.app_version = it.next().cloned(),
            "--take-over-fd" => o.take_over_fd = it.next().and_then(|s| s.parse().ok()),
            _ => {}
        }
    }
    // The integration test points a keeper at the repository's freshly bundled host this way.
    if let Ok(p) = std::env::var("CC_KEEPER_HOST_SOURCE") {
        if !p.trim().is_empty() {
            o.host_source = Some(PathBuf::from(p));
        }
    }
    o
}

/// The build this keeper's executable is from, as the options name it (`--host-source`).
pub(super) fn own_build(o: &Options) -> BuildSource {
    match &o.host_source {
        Some(dir) => BuildSource::from_host_dir(
            dir,
            o.bundle_path.clone(),
            o.app_version.clone().or_else(|| Some(env!("CARGO_PKG_VERSION").to_string())),
        ),
        None => BuildSource::dev(),
    }
}

pub(super) struct State {
    pub(super) status: HostStatus,
    /// The build the current host runs or is starting.
    pub(super) source: Option<BuildSource>,
    /// The build the next launch runs. Changed by `switch`.
    pub(super) desired: BuildSource,
    pub(super) subscribers: Vec<(u64, UnixStream)>,
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
}

impl State {
    /// An announced relaunch whose grace is still running.
    pub(super) fn relaunching(&self, now: Instant) -> bool {
        relaunch_state(self.relaunch_until, now).0
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

/// The keeper's entry point. Returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let opts = parse_args(args);
    // Started by another keeper to take its place (step 4): everything comes from that keeper.
    if let Some(fd) = opts.take_over_fd {
        return handoff::take(opts, fd);
    }
    let data = opts.data_dir.clone().unwrap_or_else(super::data_dir);
    // Before anything creates the folder: the host leaves a legacy folder alone once the new one
    // exists, so creating it first would strand the person's data (data-dir.ts).
    if let Some((from, to)) = super::prepare_default_dir(&data, std::env::var("CC_DEV").as_deref() == Ok("1")) {
        log(&format!("data folder moved: {} -> {}", from.display(), to.display()));
    }
    if let Err(e) = fs::create_dir_all(&data) {
        log(&format!("cannot create the data folder {}: {e}", data.display()));
        return 1;
    }
    let sock = socket_path(&data);

    // One keeper per data folder.
    let lock = match OpenOptions::new().create(true).read(true).write(true).mode(0o600).open(data.join("keeper.lock")) {
        Ok(f) => f,
        Err(e) => {
            log(&format!("cannot open keeper.lock: {e}"));
            return 1;
        }
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match sys::try_lock(&lock) {
            Ok(true) => break,
            Ok(false) => {}
            Err(e) => {
                log(&format!("cannot lock keeper.lock: {e}"));
                return 1;
            }
        }
        // Someone holds it. If it answers, it is the keeper: defer to it and start no host.
        if let Ok(v) = client::request(&sock, &json!({ "op": "status" }), Duration::from_secs(2)) {
            let pid = v.pointer("/view/keeper/pid").and_then(Value::as_u64).unwrap_or(0);
            log(&format!("another keeper (pid {pid}) already holds {}; leaving the host to it", data.display()));
            return EXIT_ALREADY_RUNNING;
        }
        // Held but silent: a keeper on its way out (it removes its socket first) or on its way
        // in (it binds right after locking). Either way the answer is seconds away.
        if Instant::now() >= deadline {
            log("keeper.lock is held by a keeper that does not answer; giving up after 15s");
            return 4;
        }
        thread::sleep(Duration::from_millis(200));
    }
    record_lock_holder(&lock);

    // A socket left by a keeper that died is ours to replace: we hold the lock.
    let _ = fs::remove_file(&sock);
    let listener = match sys::with_umask(0o077, || UnixListener::bind(&sock)) {
        Ok(l) => l,
        Err(e) => {
            // The usual cause is a path over the 104-byte limit for unix sockets.
            log(&format!("cannot listen on {}: {e}", sock.display()));
            return 5;
        }
    };
    let _ = fs::set_permissions(&sock, fs::Permissions::from_mode(0o600));

    // Bound here, while the keeper is still single-threaded (the socket is born under umask 077).
    // Without it the host spawns its own children, exactly as before step 2.
    let children = Children::start(&data).unwrap_or_else(|e| {
        log(&format!("child service unavailable ({e}); the host keeps its own children"));
        Children::disabled()
    });

    let desired = own_build(&opts);
    let settings = source::load_settings(&data);
    // The front door: one port and one token for this keeper's whole life (front_door.rs)
    let door = match front_door::new_token().and_then(|t| FrontDoor::open(0, t)) {
        Ok(d) => d,
        Err(e) => {
            log(&format!("cannot open the front door: {e}"));
            return 6;
        }
    };
    let now = Instant::now();
    let keeper = Arc::new(Keeper {
        info: KeeperInfo {
            pid: std::process::id(),
            protocol: KEEPER_PROTOCOL,
            version: env!("CARGO_PKG_VERSION").to_string(),
            started_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            data_dir: data.to_string_lossy().to_string(),
            build: Some(desired.clone()),
        },
        data,
        sock,
        sup: Supervisor::new(),
        door,
        children,
        state: Mutex::new(State {
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
        }),
        idle: idle_limit(),
        started: now,
        lock,
        listener,
        frozen: AtomicBool::new(false),
        handed_over: AtomicBool::new(false),
        accept_parked: AtomicBool::new(false),
        requests: AtomicUsize::new(0),
    });
    log(&format!(
        "keeper {} started (pid {}, data {}, front door {}, background {}, idle limit {}s)",
        keeper.info.version,
        keeper.info.pid,
        keeper.data.display(),
        keeper.door.url(),
        keeper.state.lock().map(|s| s.settings.background).unwrap_or(false),
        keeper.idle.as_secs()
    ));

    keeper.sup.start(sink(&keeper), launcher(&keeper));
    serve(keeper)
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
                let _ = stream.set_nonblocking(false);
                k.requests.fetch_add(1, Ordering::SeqCst);
                let k = k.clone();
                thread::spawn(move || {
                    let guard = Request(Some(k.clone()));
                    handle(k, stream, guard);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => log(&format!("accept failed: {e}")),
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

/// Writes our pid into the lock file — a description of the holder for someone reading it,
/// not the lock itself (the flock is). From the start of the file: a keeper that took the lock
/// over in a handoff shares the previous keeper's file offset.
pub(super) fn record_lock_holder(mut lock: &File) {
    let _ = lock.set_len(0);
    let _ = lock.seek(std::io::SeekFrom::Start(0));
    let _ = writeln!(lock, "{}", std::process::id());
}

pub(super) fn sink(k: &Arc<Keeper>) -> Arc<dyn StatusSink> {
    Arc::new(KeeperSink(k.clone()))
}

struct KeeperSink(Arc<Keeper>);

impl StatusSink for KeeperSink {
    fn status(&self, status: &HostStatus) {
        let k = &self.0;
        if k.handed_over.load(Ordering::SeqCst) {
            return;
        }
        // Clients only ever see the front door (#280 step 3): a ready host becomes the door's
        // target, and what the windows are told is the door's port and token, not the host's.
        let shown = match status {
            HostStatus::Ready(host) => {
                if host.token != k.door.token() {
                    log("the host's token is not the front door's; clients will be refused");
                }
                k.door.point_at(Some(host.port));
                HostStatus::Ready(HostInfo { port: k.door.port(), token: k.door.token().to_string() })
            }
            other => {
                k.door.point_at(None);
                other.clone()
            }
        };
        let ready_copy = {
            let Ok(mut st) = k.state.lock() else { return };
            st.status = shown.clone();
            if !matches!(status, HostStatus::Ready(_)) {
                st.busy = false;
                st.keeps_agents = None;
            }
            k.broadcast(&mut st);
            match status {
                HostStatus::Ready(_) => Some(st.source.as_ref().and_then(|s| s.copy_dir.clone())),
                _ => None,
            }
        };
        k.write_state_file();
        match status {
            HostStatus::Ready(info) => log(&format!("host ready on port {} behind {} (pid {:?})", info.port, k.door.url(), k.sup.pid())),
            HostStatus::Failed { message } => log(&format!("host gave up: {message}")),
            HostStatus::Restarting { attempt } => log(&format!("host restarting (attempt {attempt})")),
            HostStatus::Starting => {}
        }
        // Once a host is up, every other copy is unused: remove them.
        if let Some(keep) = ready_copy {
            let data = k.data.clone();
            thread::spawn(move || {
                let removed = source::clean_copies(&data, keep.as_deref().map(Path::new));
                if !removed.is_empty() {
                    log(&format!("removed unused host copies: {}", removed.join(", ")));
                }
            });
        }
    }

    /// The host's activity report, `{"activity":{"busy":bool}}` on its stdout — the one thing
    /// the keeper reads from the host besides the ready line. It feeds the idle rule.
    fn json_line(&self, line: &Value) -> bool {
        // The swap's two reports (#280 step 3, swap-control.ts): what a swap costs with this host,
        // and what a draining host finished or cut
        if let Some(keeps) = line.pointer("/swap/keepsAgents").and_then(Value::as_bool) {
            if let Ok(mut st) = self.0.state.lock() {
                st.keeps_agents = Some(keeps);
                self.0.broadcast(&mut st);
            }
            return true;
        }
        if let Some(report) = line.get("drained") {
            log(&format!("old host drained: {report}"));
            if let Ok(mut st) = self.0.state.lock() {
                st.drained = Some(report.clone());
            }
            return true;
        }
        let Some(busy) = line.pointer("/activity/busy").and_then(Value::as_bool) else {
            return false;
        };
        if let Ok(mut st) = self.0.state.lock() {
            if busy || st.busy {
                st.last_busy = Instant::now();
            }
            if st.busy != busy {
                st.busy = busy;
                self.0.broadcast(&mut st);
            }
        }
        true
    }
}

/// Builds each launch: copies the desired build to its per-build folder and runs it from there.
pub(super) fn launcher(k: &Arc<Keeper>) -> Launcher {
    let k = k.clone();
    Arc::new(move || {
        let desired = k.state.lock().map(|s| s.desired.clone()).map_err(|_| LaunchError::Fatal("keeper state poisoned".into()))?;
        let db = k.data.join("store.db").to_string_lossy().to_string();
        let extra = vec!["--db".to_string(), db];
        let mut running = desired.clone();
        let mut launch: HostLaunch = if desired.host_dir.is_some() {
            let copy = source::copy_into(&k.data, &desired).map_err(LaunchError::Retry)?;
            running.copy_dir = Some(copy.to_string_lossy().to_string());
            host_proc::bundled_launch(&copy.join("main.mjs"), &extra)?
        } else {
            host_proc::source_launch(&extra)
        };
        launch.env.extend(host_env(&k, &running));
        log(&format!("starting host {} from {}", running.key(), running.copy_dir.as_deref().unwrap_or("source")));
        if let Ok(mut st) = k.state.lock() {
            st.source = Some(running);
        }
        k.write_state_file();
        Ok(launch)
    })
}

/**
 * The environment every host this keeper starts gets, normal start or swap alike:
 *   - `CC_DATA_DIR`: the folder, so user-folder apps, attachments and worktrees land in it;
 *   - `CC_KEEPER`: turns on the reports only the keeper reads (activity, swap);
 *   - `CC_HOST_SOURCE`: the build record its `hello_ok` repeats;
 *   - `CC_HOST_TOKEN`: the front door's token, so every host checks the one token clients hold
 *     (#280 step 3). The host deletes it from its environment once read;
 *   - `CC_FRONT_DOOR`: the address the host gives the Codex bridge instead of its own port.
 */
fn host_env(k: &Keeper, running: &BuildSource) -> Vec<(String, String)> {
    vec![
        ("CC_DATA_DIR".into(), k.data.to_string_lossy().to_string()),
        ("CC_KEEPER".into(), "1".into()),
        ("CC_HOST_SOURCE".into(), serde_json::to_string(running).unwrap_or_default()),
        ("CC_HOST_TOKEN".into(), k.door.token().to_string()),
        ("CC_FRONT_DOOR".into(), k.door.url()),
    ]
}

impl Keeper {
    pub(super) fn view(&self, st: &State) -> KeeperView {
        KeeperView {
            keeper: self.info.clone(),
            status: st.status.clone(),
            host_pid: self.sup.pid(),
            source: st.source.clone(),
            background: st.settings.background,
            attached: st.attached,
            busy: st.busy,
            swap: st.swap.clone(),
            keeps_agents: st.keeps_agents,
        }
    }

    /// Pushes the current view to every attached window, dropping any that stopped reading. Not
    /// while frozen for a handoff: the windows' sockets may be in two keepers' hands then, and two
    /// writers could interleave half lines.
    pub(super) fn broadcast(&self, st: &mut State) {
        if self.frozen.load(Ordering::SeqCst) || self.handed_over.load(Ordering::SeqCst) {
            return;
        }
        let line = match serde_json::to_vec(&json!({ "event": "status", "view": self.view(st) })) {
            Ok(mut v) => {
                v.push(b'\n');
                v
            }
            Err(_) => return,
        };
        st.subscribers.retain_mut(|(_, s)| s.write_all(&line).is_ok());
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
    let mut line = serde_json::to_vec(v).unwrap_or_default();
    line.push(b'\n');
    let _ = stream.write_all(&line);
}

fn handle(k: Arc<Keeper>, mut stream: UnixStream, guard: Request) {
    match sys::peer_uid(&stream) {
        Ok(uid) if uid == sys::my_uid() => {}
        other => {
            log(&format!("refused a connection from another user ({other:?})"));
            return;
        }
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
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
            let view = k.state.lock().map(|st| k.view(&st)).ok();
            reply(&mut stream, &json!({ "ok": true, "view": view }));
        }
        "attach" => attach(k, stream, reader, &req, guard),
        "stop" => {
            reply(&mut stream, &json!({ "ok": true }));
            drop(stream);
            k.shutdown("asked to stop (Quit completely, or Restart completely)");
        }
        "relaunching" => relaunching(&k, &mut stream, &req),
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
            let saved = source::save_settings(&k.data, &Settings { background: on });
            if let Err(e) = saved {
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

fn attach(k: Arc<Keeper>, mut stream: UnixStream, reader: BufReader<UnixStream>, req: &Value, mut guard: Request) {
    let protocol = req.get("protocol").and_then(Value::as_u64).unwrap_or(0);
    if protocol != KEEPER_PROTOCOL as u64 {
        return reply(
            &mut stream,
            &json!({ "ok": false, "error": format!("keeper protocol mismatch (keeper {KEEPER_PROTOCOL}, app {protocol})") }),
        );
    }
    let client: Option<BuildSource> = req.get("build").cloned().and_then(|b| serde_json::from_value(b).ok());
    let Ok(push) = stream.try_clone() else { return };
    let id = {
        let Ok(mut st) = k.state.lock() else { return };
        if st.stopping {
            drop(st);
            return reply(&mut stream, &json!({ "ok": false, "error": "the keeper is stopping" }));
        }
        let id = st.next_id;
        st.next_id += 1;
        st.attached += 1;
        st.ever_attached = true;
        // The window an announced relaunch started (#352): it is told so, and the grace is spent
        let relaunched = st.relaunching(Instant::now());
        if st.relaunch_until.take().is_some() {
            log(if relaunched {
                "a window attached after the announced relaunch"
            } else {
                "a window attached after the relaunch grace had run out"
            });
        }
        let same = match (&client, &st.source) {
            (Some(c), Some(s)) => Some(c.same_build(s)),
            _ => None,
        };
        // Whether the keeper itself is from the window's build (step 4): None for a keeper that
        // cannot say (older than step 4)
        let keeper_same = match (&client, &k.info.build) {
            (Some(c), Some(b)) => Some(c.same_build(b)),
            _ => None,
        };
        // The answer goes out before this window is added to the push list, under the same lock,
        // so no event can overtake it.
        reply(
            &mut stream,
            &json!({ "ok": true, "view": k.view(&st), "sameBuild": same, "keeperSameBuild": keeper_same, "relaunched": relaunched }),
        );
        st.subscribers.push((id, push));
        k.broadcast(&mut st);
        id
    };
    // From here the window is a subscriber, not a request a freeze has to wait for.
    guard.done();
    let _ = stream.set_read_timeout(None);
    watch_window(k, id, reader);
}

/// Waits for an attached window to go away (its connection ending is the detach) and applies
/// background mode. Shared by `attach` and a keeper that took the window over in a handoff.
pub(super) fn watch_window(k: Arc<Keeper>, id: u64, mut reader: BufReader<UnixStream>) {
    // The window says nothing more; the connection ending is the detach.
    while let Ok(Some(_)) = read_line(&mut reader) {}
    // Handed over: the window is the next keeper's to count (it sees the same end).
    if k.handed_over.load(Ordering::SeqCst) {
        return;
    }
    let stop = {
        let Ok(mut st) = k.state.lock() else { return };
        st.subscribers.retain(|(i, _)| *i != id);
        st.attached = st.attached.saturating_sub(1);
        let now = Instant::now();
        st.last_detach = now;
        k.broadcast(&mut st);
        if st.attached == 0 && st.relaunching(now) {
            log("the last window closed for an announced relaunch; waiting for it to come back");
        }
        stop_on_detach(st.attached, st.settings.background, st.relaunching(now))
    };
    // Frozen: the decision waits for the thaw, when the idle rule sees no window either.
    if stop && !k.frozen.load(Ordering::SeqCst) {
        k.shutdown("the last window closed and background mode is off");
    }
}

/**
 * `relaunching` (#352): the app is about to close its window and start again from its updated
 * bundle ("Apply now"). Until the grace runs out, no window attached is not "the last window
 * left", even with background mode off, so the update cuts nothing because of that setting. The
 * next window to attach spends the grace and is told it is the relaunched one (`relaunched` in its
 * attach answer), so it can apply the switch by itself. If none comes back in time, the idle rule
 * applies as if nothing had been announced: with background mode off, the keeper stops.
 *
 * Peer-uid checked like every request (`handle`); it changes nothing a process of this user could
 * not do with `set_background` anyway, and only for a bounded time.
 */
fn relaunching(k: &Arc<Keeper>, stream: &mut UnixStream, req: &Value) {
    let grace = relaunch_grace(req.get("graceSecs").and_then(Value::as_u64));
    {
        let Ok(mut st) = k.state.lock() else { return };
        if st.stopping {
            drop(st);
            return reply(stream, &json!({ "ok": false, "error": "the keeper is stopping" }));
        }
        st.relaunch_until = Some(Instant::now() + grace);
    }
    log(&format!("the app announced a relaunch; holding for up to {}s with no window", grace.as_secs()));
    reply(stream, &json!({ "ok": true, "graceSecs": grace.as_secs() }));
}

/// Registers a window connection another keeper handed over (step 4) and watches it.
pub(super) fn adopt_window(k: &Arc<Keeper>, stream: UnixStream) {
    let Ok(read_half) = stream.try_clone() else { return };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let id = {
        let Ok(mut st) = k.state.lock() else { return };
        let id = st.next_id;
        st.next_id += 1;
        st.attached += 1;
        st.ever_attached = true;
        st.subscribers.push((id, stream));
        id
    };
    let k = k.clone();
    thread::spawn(move || watch_window(k, id, BufReader::new(read_half)));
}

/// Switches the host to the requesting app's build: a blue-green swap when a host is up
/// (`swap.rs`), else the next start runs it. The build stamp is re-read from the folder
/// rather than taken from the request, so the keeper's record says what will actually run.
fn switch(k: Arc<Keeper>, stream: &mut UnixStream, req: &Value) {
    let asked: Option<BuildSource> = req.get("source").cloned().and_then(|s| serde_json::from_value(s).ok());
    let Some(asked) = asked else {
        return reply(stream, &json!({ "ok": false, "error": "switch needs a source" }));
    };
    let next = match asked.host_dir.as_deref() {
        Some(dir) if Path::new(dir).join("main.mjs").is_file() => {
            BuildSource::from_host_dir(Path::new(dir), asked.bundle_path.clone(), asked.version.clone())
        }
        Some(dir) => return reply(stream, &json!({ "ok": false, "error": format!("no host in {dir}") })),
        None if asked.commit == "dev" => BuildSource::dev(),
        None => return reply(stream, &json!({ "ok": false, "error": "switch needs a host folder" })),
    };
    // The new build's keeper executable, from the window asking (step 4): hand the keeper over first
    if let Some(exe) = req.pointer("/keeper/exe").and_then(Value::as_str).map(PathBuf::from) {
        if k.info.build.as_ref().map(|b| !b.same_build(&next)).unwrap_or(true) {
            {
                let Ok(mut st) = k.state.lock() else { return };
                if st.swapping {
                    drop(st);
                    return reply(stream, &json!({ "ok": false, "error": "a build switch is already in progress" }));
                }
                st.swapping = true;
            }
            reply(stream, &json!({ "ok": true }));
            log(&format!("switching to {}: the keeper first, from {}", next.key(), exe.display()));
            thread::spawn(move || move_keeper(k, exe, next, true));
            return;
        }
    }
    log(&format!("switching the host to {} (from {})", next.key(), next.bundle_path.as_deref().unwrap_or("?")));
    begin_switch(k, next, None, Some(stream));
}

/// Starts a host switch already decided on: a blue-green swap when a host is up, else the next
/// start runs the new build. `stream`, when there is one, is answered once it is under way.
pub(super) fn begin_switch(k: Arc<Keeper>, next: BuildSource, keeper_message: Option<String>, mut stream: Option<&mut UnixStream>) {
    let blue_green = {
        let Ok(mut st) = k.state.lock() else { return };
        // A stream means a fresh request; without one the caller (a keeper move) already holds it
        if st.swapping && stream.is_some() {
            drop(st);
            if let Some(s) = stream.as_mut() {
                reply(s, &json!({ "ok": false, "error": "a build switch is already in progress" }));
            }
            return;
        }
        // Only a host that is up has anything to hand over; otherwise the next start simply runs
        // the new build
        let up = matches!(st.status, HostStatus::Ready(_)) && k.sup.is_running() && next.host_dir.is_some();
        if up {
            st.swapping = true;
        } else {
            st.swapping = false;
            st.desired = next.clone();
            if let Some(m) = &keeper_message {
                // Nothing to swap, but the window should still hear why the keeper stayed behind
                st.swap = Some(SwapView {
                    phase: Phase::Done,
                    target: next.clone(),
                    from: st.source.clone(),
                    message: None,
                    rolled_back: false,
                    cut: Vec::new(),
                    keeper_message: Some(m.clone()),
                    started_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
                });
                k.broadcast(&mut st);
            }
        }
        up
    };
    if let Some(s) = stream {
        reply(s, &json!({ "ok": true }));
    }
    if blue_green {
        thread::spawn(move || swap_to(k, next, keeper_message));
    } else if !k.sup.bounce() {
        // A host still starting is bounced into the new build; one that had given up starts fresh
        k.sup.restart(sink(&k), launcher(&k));
    }
}

/**
 * `upgrade`: hands the keeper over to the keeper at `exe` (of build `source`), leaving the host
 * alone (#280 step 4). The app's switch reaches the same thing through `switch` with `keeper`; this
 * one exists for a keeper that is behind while the host is not, and for the integration test.
 */
fn upgrade(k: Arc<Keeper>, stream: &mut UnixStream, req: &Value) {
    let Some(exe) = req.get("exe").and_then(Value::as_str).map(PathBuf::from) else {
        return reply(stream, &json!({ "ok": false, "error": "upgrade needs exe" }));
    };
    let asked: Option<BuildSource> = req.get("source").cloned().and_then(|s| serde_json::from_value(s).ok());
    let target = match asked.as_ref().and_then(|a| a.host_dir.clone()) {
        Some(dir) if Path::new(&dir).join("main.mjs").is_file() => {
            let a = asked.unwrap_or_default();
            BuildSource::from_host_dir(Path::new(&dir), a.bundle_path, a.version)
        }
        _ => return reply(stream, &json!({ "ok": false, "error": "upgrade needs a source with a host folder" })),
    };
    {
        let Ok(mut st) = k.state.lock() else { return };
        if st.swapping {
            drop(st);
            return reply(stream, &json!({ "ok": false, "error": "a build switch is already in progress" }));
        }
        st.swapping = true;
    }
    reply(stream, &json!({ "ok": true }));
    thread::spawn(move || move_keeper(k, exe, target, false));
}

/**
 * Hands this keeper over to the keeper at `exe` (#280 step 4), then, when `switch_host` and the
 * host is of another build, has the new keeper swap the host too. On success this never returns:
 * the process exits once the new keeper has committed.
 *
 * If the handoff fails, this keeper carries on as it was (`handoff::give` rolled it back), and a
 * host switch that was asked for still runs here, under this keeper: the window is told the keeper
 * stayed behind and why.
 */
fn move_keeper(k: Arc<Keeper>, exe: PathBuf, target: BuildSource, switch_host: bool) {
    let (from, host_differs) = match k.state.lock() {
        Ok(st) => (st.source.clone(), st.source.as_ref().map(|s| !s.same_build(&target)).unwrap_or(true)),
        Err(_) => return,
    };
    let then_switch = (switch_host && host_differs).then(|| target.clone());
    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let view = |phase: Phase, message: Option<String>, keeper_message: Option<String>| SwapView {
        phase,
        target: target.clone(),
        from: from.clone(),
        message,
        rolled_back: false,
        cut: Vec::new(),
        keeper_message,
        started_at,
    };
    if let Ok(mut st) = k.state.lock() {
        st.swap = Some(view(Phase::HandingOver, None, None));
        k.broadcast(&mut st);
    }
    let Err(why) = handoff::give(&k, &exe, &target, then_switch) else { return };
    log(&format!("the keeper stays on its build: {why}"));
    if switch_host && host_differs {
        // The host switch still happens, under this keeper
        begin_switch(k, target, Some(why), None);
        return;
    }
    if let Ok(mut st) = k.state.lock() {
        st.swapping = false;
        st.swap = Some(view(Phase::Failed, Some(format!("could not hand over to the new build's keeper: {why}")), Some(why)));
        k.broadcast(&mut st);
    }
}

/// Runs a blue-green swap (`swap.rs`) and applies its outcome to the keeper's state.
pub(super) fn swap_to(k: Arc<Keeper>, next: BuildSource, keeper_message: Option<String>) {
    let (from, current_copy) = match k.state.lock() {
        Ok(mut st) => {
            st.drained = None;
            (st.source.clone(), st.source.as_ref().and_then(|s| s.copy_dir.clone()).map(PathBuf::from))
        }
        Err(_) => return,
    };
    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let view = |phase: Phase| SwapView {
        phase,
        target: next.clone(),
        from: from.clone(),
        message: None,
        rolled_back: false,
        cut: Vec::new(),
        keeper_message: keeper_message.clone(),
        started_at,
    };
    let show = |v: SwapView| {
        log(&format!(
            "swap to {}: {:?}{}",
            v.target.key(),
            v.phase,
            v.message.as_deref().map(|m| format!(" ({m})")).unwrap_or_default()
        ));
        if let Ok(mut st) = k.state.lock() {
            st.swap = Some(v);
            k.broadcast(&mut st);
        }
    };
    let env_for = |b: &BuildSource| host_env(&k, b);
    let drained = || k.state.lock().ok().and_then(|st| st.drained.clone());
    let progress = |phase: Phase| show(view(phase));
    let adopt = |host: host_proc::Adopted, running: BuildSource| -> Result<(), String> {
        if let Ok(mut st) = k.state.lock() {
            st.source = Some(running.clone());
            st.desired = running;
        }
        k.write_state_file();
        k.sup.adopt(host, sink(&k), launcher(&k)).map_err(|mut h| {
            host_proc::stop_child(&mut h.child);
            "the keeper was still supervising another host".to_string()
        })
    };
    let outcome = swap::run(&swap::Plan {
        data: &k.data,
        next: next.clone(),
        current_copy,
        sup: &k.sup,
        door: &k.door,
        drain_bound: swap::drain_bound(),
        env_for: &env_for,
        drained: &drained,
        progress: &progress,
        adopt: &adopt,
    });
    match outcome {
        swap::Outcome::Done { cut } => show(SwapView { cut, ..view(Phase::Done) }),
        // The running host was never touched
        swap::Outcome::NotStarted(message) => show(SwapView { message: Some(message), ..view(Phase::Failed) }),
        swap::Outcome::FailedAfterDrain { message, cut } => {
            // The old host is gone and its lock released: start its build again (swap.rs)
            if let Ok(mut st) = k.state.lock() {
                if let Some(prev) = from.clone() {
                    st.desired = prev.clone();
                    st.source = Some(prev);
                }
            }
            show(SwapView { message: Some(message), rolled_back: true, cut, ..view(Phase::Failed) });
            k.sup.restart(sink(&k), launcher(&k));
        }
    }
    if let Ok(mut st) = k.state.lock() {
        st.swapping = false;
        k.broadcast(&mut st);
    }
    k.write_state_file();
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_options_the_app_passes() {
        let args: Vec<String> = [
            "centralu",
            "--keeper",
            "--data-dir",
            "/tmp/d",
            "--host-source",
            "/A.app/Contents/Resources/resources/host",
            "--bundle-path",
            "/A.app",
            "--app-version",
            "0.1.0",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let o = parse_args(&args);
        assert_eq!(o.data_dir, Some(PathBuf::from("/tmp/d")));
        assert_eq!(o.bundle_path.as_deref(), Some("/A.app"));
        assert_eq!(o.app_version.as_deref(), Some("0.1.0"));
        if std::env::var("CC_KEEPER_HOST_SOURCE").is_err() {
            assert_eq!(o.host_source, Some(PathBuf::from("/A.app/Contents/Resources/resources/host")));
        }
    }
}
