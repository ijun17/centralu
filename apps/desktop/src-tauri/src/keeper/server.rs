//! The keeper process: `centralu --keeper`.
//!
//! Control socket protocol (`<data>/keeper.sock`, newline-delimited JSON, one request per
//! connection except `attach`):
//!
//! | request | answer |
//! |---|---|
//! | `{"op":"status"}` | `{"ok":true,"view":KeeperView}` — host state, the front door's port and token, build source, the last swap |
//! | `{"op":"attach","protocol":1,"build":BuildSource?}` | `{"ok":true,"view":..,"sameBuild":bool?}`, then one `{"event":"status","view":..}` line per change for as long as the connection stays open |
//! | `{"op":"stop"}` | `{"ok":true}`, then the host is stopped and the keeper exits |
//! | `{"op":"switch","source":BuildSource}` | `{"ok":true}`, then a blue-green swap to that build (`swap.rs`), its phases pushed to attached windows in `view.swap`; with no host up, a plain start |
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
//! host's: the same for as long as this keeper lives, whichever host is behind them.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::children::{self, Children};
use super::client::{self, read_line};
use super::front_door::{self, FrontDoor};
use super::source::{self, BuildSource, Settings};
use super::swap::{self, Phase, SwapView};
use super::{idle_decision, idle_limit, socket_path, sys, IdleInput, KeeperInfo, KeeperView, EXIT_ALREADY_RUNNING, KEEPER_PROTOCOL};
use crate::host_proc::{self, HostInfo, HostLaunch, HostStatus, LaunchError, Launcher, StatusSink, Supervisor};

/// Command-line options. The app passes all of them; a person starting a keeper by hand can
/// leave them out (it then runs the host from source, as a debug build would).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Options {
    pub data_dir: Option<PathBuf>,
    pub host_source: Option<PathBuf>,
    pub bundle_path: Option<String>,
    pub app_version: Option<String>,
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

struct State {
    status: HostStatus,
    /// The build the current host runs or is starting.
    source: Option<BuildSource>,
    /// The build the next launch runs. Changed by `switch`.
    desired: BuildSource,
    subscribers: Vec<(u64, UnixStream)>,
    next_id: u64,
    attached: usize,
    ever_attached: bool,
    last_detach: Instant,
    busy: bool,
    last_busy: Instant,
    settings: Settings,
    stopping: bool,
    /// The current or last swap, as the windows are shown it.
    swap: Option<SwapView>,
    /// A swap is running: a second `switch` and `restart` are refused until it ends.
    swapping: bool,
    /// The draining host's `{"drained":..}` report.
    drained: Option<Value>,
    /// The current host's `{"swap":{"keepsAgents":..}}` report.
    keeps_agents: Option<bool>,
}

struct Keeper {
    data: PathBuf,
    sock: PathBuf,
    info: KeeperInfo,
    sup: Supervisor,
    /// Where every client connects, whichever host is current (#280 step 3).
    door: FrontDoor,
    /// Agents, terminals and commands the keeper holds for its hosts (step 2, `children/`).
    children: Children,
    state: Mutex<State>,
    idle: Duration,
    started: Instant,
}

/// The keeper's entry point. Returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let opts = parse_args(args);
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

    let desired = match &opts.host_source {
        Some(dir) => BuildSource::from_host_dir(
            dir,
            opts.bundle_path.clone(),
            opts.app_version.clone().or_else(|| Some(env!("CARGO_PKG_VERSION").to_string())),
        ),
        None => BuildSource::dev(),
    };
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
        }),
        idle: idle_limit(),
        started: now,
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
    spawn_idle_watch(keeper.clone());

    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let k = keeper.clone();
                thread::spawn(move || handle(k, stream));
            }
            Err(e) => log(&format!("accept failed: {e}")),
        }
    }
    0
}

fn log(msg: &str) {
    eprintln!("[keeper] {msg}");
}

/// Writes our pid into the lock file — a description of the holder for someone reading it,
/// not the lock itself (the flock is).
fn record_lock_holder(mut lock: &File) {
    let _ = lock.set_len(0);
    let _ = writeln!(lock, "{}", std::process::id());
}

fn sink(k: &Arc<Keeper>) -> Arc<dyn StatusSink> {
    Arc::new(KeeperSink(k.clone()))
}

struct KeeperSink(Arc<Keeper>);

impl StatusSink for KeeperSink {
    fn status(&self, status: &HostStatus) {
        let k = &self.0;
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
fn launcher(k: &Arc<Keeper>) -> Launcher {
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
    fn view(&self, st: &State) -> KeeperView {
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

    /// Pushes the current view to every attached window, dropping any that stopped reading.
    fn broadcast(&self, st: &mut State) {
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
    fn write_state_file(&self) {
        let Ok(st) = self.state.lock() else { return };
        let body = json!({
            "pid": self.info.pid,
            "protocol": self.info.protocol,
            "version": self.info.version,
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

fn spawn_idle_watch(k: Arc<Keeper>) {
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

fn handle(k: Arc<Keeper>, mut stream: UnixStream) {
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
    match op {
        "status" => {
            let view = k.state.lock().map(|st| k.view(&st)).ok();
            reply(&mut stream, &json!({ "ok": true, "view": view }));
        }
        "attach" => attach(k, stream, reader, &req),
        "stop" => {
            reply(&mut stream, &json!({ "ok": true }));
            drop(stream);
            k.shutdown("asked to stop (Quit and stop agents)");
        }
        "switch" => switch(k, &mut stream, &req),
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

fn attach(k: Arc<Keeper>, mut stream: UnixStream, mut reader: BufReader<UnixStream>, req: &Value) {
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
        let same = match (&client, &st.source) {
            (Some(c), Some(s)) => Some(c.same_build(s)),
            _ => None,
        };
        // The answer goes out before this window is added to the push list, under the same lock,
        // so no event can overtake it.
        reply(&mut stream, &json!({ "ok": true, "view": k.view(&st), "sameBuild": same }));
        st.subscribers.push((id, push));
        k.broadcast(&mut st);
        id
    };
    let _ = stream.set_read_timeout(None);
    // The window says nothing more; the connection ending is the detach.
    while let Ok(Some(_)) = read_line(&mut reader) {}
    let stop = {
        let Ok(mut st) = k.state.lock() else { return };
        st.subscribers.retain(|(i, _)| *i != id);
        st.attached = st.attached.saturating_sub(1);
        st.last_detach = Instant::now();
        k.broadcast(&mut st);
        st.attached == 0 && !st.settings.background
    };
    if stop {
        k.shutdown("the last window closed and background mode is off");
    }
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
    log(&format!("switching the host to {} (from {})", next.key(), next.bundle_path.as_deref().unwrap_or("?")));
    let blue_green = {
        let Ok(mut st) = k.state.lock() else { return };
        if st.swapping {
            drop(st);
            return reply(stream, &json!({ "ok": false, "error": "a build switch is already in progress" }));
        }
        // Only a host that is up has anything to hand over; otherwise the next start simply runs
        // the new build
        let up = matches!(st.status, HostStatus::Ready(_)) && k.sup.is_running() && next.host_dir.is_some();
        if up {
            st.swapping = true;
        } else {
            st.desired = next.clone();
        }
        up
    };
    reply(stream, &json!({ "ok": true }));
    if blue_green {
        thread::spawn(move || swap_to(k, next));
    } else if !k.sup.bounce() {
        // A host still starting is bounced into the new build; one that had given up starts fresh
        k.sup.restart(sink(&k), launcher(&k));
    }
}

/// Runs a blue-green swap (`swap.rs`) and applies its outcome to the keeper's state.
fn swap_to(k: Arc<Keeper>, next: BuildSource) {
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
