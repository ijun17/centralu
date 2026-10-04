//! The keeper hands itself over to a new keeper (#280, option C step 4).
//!
//! A keeper update must cut nothing: not the host, not an agent mid-turn, not a terminal, not a
//! dev server, not a client's connection. `exec` would keep the pid and descriptors on macOS and
//! Linux but has no Windows equivalent, so the owner's direction is the same on every OS: **start
//! the new keeper, pass it every handle, let the old one exit** (#280, "The keeper's own upgrade").
//!
//! **Who starts whom.** The outgoing keeper (A) starts the incoming one (B) from the new build's
//! executable **inside its bundle**, the path the attaching app reports (`current_exe`), as
//! `centralu --keeper --take-over-fd 3 ...`. Never a copy of the executable: the keeper is the app's
//! own signed executable precisely so macOS attributes it to Centralu (`app.centralu`, #220), and a
//! copy outside the bundle would be a new, unsigned-looking program. The bundle being replaced
//! later does not disturb B either: `tauri build` and `centralu install` both delete the old bundle
//! and write a new one (new inodes), and a running executable whose file was unlinked keeps running.
//!
//! **The channel** is one end of a `socketpair` that A puts at B's descriptor 3. It has no path,
//! so no other process can connect to it at all (stronger than a 0600 socket file, and nothing to
//! clean up); B still checks that its peer is this user.
//!
//! **The protocol** (`wire.rs` frames):
//!
//! | step | who | what |
//! |---|---|---|
//! | 1 | B → A | `hello` {protocol, pid, version, build} |
//! | 2 | A | **freeze**: stop accepting on `keeper.sock` (connections queue), wait for requests in progress, park every front-door relay between copies, pause the host's stdout reader between lines, freeze the child table (it reaps what exited, then stops all I/O) |
//! | 3 | A → B | `state`: the snapshot (`KeeperSnap`) + every buffer as a blob + every descriptor over `SCM_RIGHTS`: `keeper.lock`, `keeper.sock`, `children.sock`, the front door's listener, the host's stdin and stdout, each child's pipes or pty master, each child-socket connection, each relayed connection (client and host side), each attached window |
//! | 4 | B | rebuilds everything **without any I/O**: checks it really holds the lock (`flock` on the passed description), registers exit watches, builds the tables |
//! | 5 | B → A | `ready` (or `fail` with the reason) |
//! | 6 | A | **commit point**: receiving `ready`. From here A never resumes. It reaps the children and host that exited during the freeze (it is still their parent), sends `commit` {reaped}, and exits without touching anything |
//! | 7 | B | on `commit`: starts every reader and writer, adopts the host, rewrites `keeper.json`, and serves; then runs the host switch it was handed, if any |
//!
//! **Rollback.** Anything before the commit point — B not starting, B failing to rebuild, B dying,
//! a timeout — makes A send `abort` (best effort), kill B (its own child), and thaw everything in
//! reverse order. A never closed or moved anything (the snapshot holds duplicates), and while frozen
//! it read nothing, so it carries on exactly where it stopped. B, on `abort`, exits without acting.
//! If B instead sees the channel close after `ready` with no `commit`, A died at the worst moment:
//! B takes over if A is gone (it has the whole state, and nobody else does) and exits if A is
//! still alive (A must then be resuming).
//!
//! **The lock** never has a gap: B holds a duplicate of the same open file description, so the
//! `flock` is held by both until A exits, and by B after. A third keeper starting at any point is
//! refused, as it always was.
//!
//! **What survives and what reconnects.** Survive, untouched: the host process and its pipes;
//! every child; every child-socket connection (the host's control and attach streams, so the host
//! does not notice); every front-door connection (the webview's WebSocket, app view traffic, Codex
//! bridges: the same TCP sockets, pumped by B); every attached window's control connection; and
//! anything waiting in a listen queue. Answered with "try again": a control request (other than
//! `status`) that arrived in the instant of the freeze. Nothing is closed.

pub mod pack;
pub mod wire;

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use self::pack::{Pack, Unpack};
use super::children::{self, Children, ExitStatus};
use super::front_door::{DoorFreeze, FrontDoor};
use super::server::{self, Keeper, Options, State};
use super::source::{self, BuildSource};
use super::swap::{Phase, SwapView};
use super::{sys, KeeperInfo, KEEPER_FLAG, KEEPER_PROTOCOL};
use crate::host_proc::{ForeignAdopt, HostInfo, HostStatus, Supervisor};

/// The snapshot format. A newer keeper reads an older keeper's snapshot (the outgoing keeper is
/// the older build in an update), so fields are only ever added, with defaults.
pub const HANDOFF_PROTOCOL: u32 = 1;

/// Exit code of an incoming keeper whose handoff was aborted: it served nothing.
pub const EXIT_ABORTED: i32 = 7;

/// How long the incoming keeper may take to say hello: it only has to start and parse its options.
const HELLO_LIMIT: Duration = Duration::from_secs(20);
/// How long each part of the freeze may take. A relay mid-copy finishes in microseconds; only a
/// client that stopped reading holds it up, and then rolling back is right.
const FREEZE_LIMIT: Duration = Duration::from_secs(3);
/// How long the incoming keeper may take to rebuild and say ready.
const READY_LIMIT: Duration = Duration::from_secs(30);

fn log(msg: &str) {
    eprintln!("[keeper] handoff: {msg}");
}

/// The keeper's own part of a snapshot; the child table travels as the reactor's own state.
#[derive(Serialize, Deserialize)]
struct KeeperSnap {
    protocol: u32,
    from_pid: u32,
    from_version: String,
    lock: usize,
    sock: usize,
    status: HostStatus,
    source: Option<BuildSource>,
    desired: BuildSource,
    background: bool,
    windows: Vec<usize>,
    ever_attached: bool,
    since_start_ms: u64,
    since_detach_ms: u64,
    busy: bool,
    since_busy_ms: u64,
    swap: Option<SwapView>,
    keeps_agents: Option<bool>,
    door: DoorSnap,
    host: Option<HostSnap>,
    /// The child table and where its descriptors and blobs start in the message.
    children: Option<ChildrenSnap>,
    /// A host switch the incoming keeper runs once it serves (the app's "Switch to this build").
    then_switch: Option<BuildSource>,
}

#[derive(Serialize, Deserialize)]
struct DoorSnap {
    listener: usize,
    token: String,
    target: Option<u16>,
    relays: Vec<(usize, Option<usize>)>,
}

#[derive(Serialize, Deserialize)]
struct HostSnap {
    pid: u32,
    stdin: usize,
    stdout: usize,
    buffered: usize,
    info: HostInfo,
}

#[derive(Serialize, Deserialize)]
struct ChildrenSnap {
    state: Value,
    fd_base: usize,
    blob_base: usize,
}

/// What has been frozen so far, to undo in reverse on a rollback.
#[derive(Default)]
struct Frozen {
    keeper: bool,
    door: bool,
    host: bool,
    children: bool,
}

fn thaw(k: &Keeper, f: &Frozen) {
    if f.children {
        k.children.thaw();
    }
    if f.host {
        k.sup.thaw();
    }
    if f.door {
        k.door.thaw();
    }
    if f.keeper {
        k.frozen.store(false, Ordering::SeqCst);
        if let Ok(mut st) = k.state.lock() {
            k.broadcast(&mut st);
        }
    }
}

/**
 * Hands this keeper over to the keeper at `exe`, of build `target`. Returns only on failure, after
 * rolling everything back; on success the process exits.
 */
pub(super) fn give(k: &Arc<Keeper>, exe: &Path, target: &BuildSource, then_switch: Option<BuildSource>) -> Result<(), String> {
    if !exe.is_file() {
        return Err(format!("the new build's executable is not at {}", exe.display()));
    }
    {
        let st = k.state.lock().map_err(|_| "keeper state poisoned")?;
        if st.stopping {
            return Err("the keeper is stopping".into());
        }
    }
    let (mut child, mut ch) = spawn_successor(k, exe, target).map_err(|e| format!("could not start the new keeper: {e}"))?;
    log(&format!("handing over to keeper pid {} from {}", child.id(), exe.display()));
    let fail = |child: &mut Child, ch: &mut UnixStream, f: &Frozen, why: String| -> Result<(), String> {
        let _ = wire::send_op(ch, &json!({ "op": "abort" }));
        let _ = child.kill();
        let _ = child.wait();
        thaw(k, f);
        log(&format!("rolled back: {why}"));
        Err(why)
    };
    let mut frozen = Frozen::default();

    // 1. hello
    let hello = match wire::recv(&mut ch, HELLO_LIMIT) {
        Ok(m) if m.op() == "hello" => m.header,
        Ok(m) => return fail(&mut child, &mut ch, &frozen, format!("the new keeper said {:?} instead of hello", m.op())),
        Err(e) => return fail(&mut child, &mut ch, &frozen, format!("the new keeper did not start: {e}")),
    };
    let theirs = hello.get("protocol").and_then(Value::as_u64).unwrap_or(0);
    if theirs < HANDOFF_PROTOCOL as u64 {
        return fail(&mut child, &mut ch, &frozen, format!("the new keeper reads handoff format {theirs}, this one writes {HANDOFF_PROTOCOL}"));
    }

    // 2. freeze
    let snap = match freeze(k, &mut frozen, then_switch) {
        Ok(s) => s,
        Err(why) => return fail(&mut child, &mut ch, &frozen, why),
    };
    let (header, pack) = snap;

    // 3. state
    if let Err(e) = wire::send(&mut ch, &json!({ "op": "state", "snap": header }), &pack.blobs, &pack.raw_fds()) {
        return fail(&mut child, &mut ch, &frozen, format!("could not pass the state on: {e}"));
    }
    drop(pack); // our duplicates; the originals stay ours until we exit

    // 5. ready
    match wire::recv(&mut ch, READY_LIMIT) {
        Ok(m) if m.op() == "ready" => {}
        Ok(m) if m.op() == "fail" => {
            let why = m.header.get("error").and_then(Value::as_str).unwrap_or("no reason given").to_string();
            return fail(&mut child, &mut ch, &frozen, format!("the new keeper could not take over: {why}"));
        }
        Ok(m) => return fail(&mut child, &mut ch, &frozen, format!("the new keeper said {:?} instead of ready", m.op())),
        Err(e) => return fail(&mut child, &mut ch, &frozen, format!("the new keeper did not finish taking over: {e}")),
    }

    // 6. commit point: from here this keeper never resumes
    k.handed_over.store(true, Ordering::SeqCst);
    let mut reaped: Vec<(i32, ExitStatus)> = k.children.reap_now(Duration::from_secs(2));
    if let Some(pid) = k.sup.pid() {
        if let Some(st) = children::reap_pid(pid as i32) {
            reaped.push((pid as i32, st));
        }
    }
    let reaped_json: Vec<Value> = reaped.iter().map(|(pid, st)| json!([pid, st.code, st.signal])).collect();
    let sent = wire::send_op(&mut ch, &json!({ "op": "commit", "reaped": reaped_json }));
    log(&format!(
        "handed over to keeper pid {} ({}); this keeper (pid {}) exits",
        child.id(),
        if sent.is_ok() { "committed" } else { "the commit could not be sent; it takes over on seeing this keeper gone" },
        std::process::id()
    ));
    // No destructors, no shutdown path: the next keeper owns every socket, pipe and child now.
    std::process::exit(0);
}

/// Step 2: stops all I/O and describes everything. On error, whatever was frozen stays marked in
/// `f` for the caller to thaw.
fn freeze(k: &Arc<Keeper>, f: &mut Frozen, then_switch: Option<BuildSource>) -> Result<(Value, Pack), String> {
    // The control socket: stop accepting, wait for answers in progress
    k.frozen.store(true, Ordering::SeqCst);
    f.keeper = true;
    let deadline = Instant::now() + FREEZE_LIMIT;
    while !k.accept_parked.load(Ordering::SeqCst) || k.requests.load(Ordering::SeqCst) > 0 {
        if Instant::now() >= deadline {
            return Err("a control request did not finish in time".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let door = k.door.freeze(FREEZE_LIMIT)?;
    f.door = true;
    let host = k.sup.freeze(FREEZE_LIMIT)?;
    f.host = true;
    let table = k.children.freeze(Duration::from_secs(5))?;
    f.children = true;

    let mut pack = Pack::default();
    let e = |e: std::io::Error| e.to_string();
    let lock = pack.fd(&k.lock).map_err(e)?;
    let sock = pack.fd(&k.listener).map_err(e)?;
    let door_snap = pack_door(&mut pack, door, k.door.token())?;
    let host_snap = match host {
        Some(h) => {
            let info = h.info.clone().ok_or("the host has not said where it listens")?;
            Some(HostSnap {
                pid: h.pid,
                stdin: pack.owned(h.stdin),
                stdout: pack.owned(h.stdout),
                buffered: pack.blob(h.buffered),
                info,
            })
        }
        None => None,
    };
    let children_snap = table.map(|(state, part)| {
        let (fd_base, blob_base) = pack.absorb(part);
        ChildrenSnap { state, fd_base, blob_base }
    });
    let st = k.state.lock().map_err(|_| "keeper state poisoned")?;
    let mut windows = Vec::new();
    for (_, s) in &st.subscribers {
        windows.push(pack.fd(s).map_err(e)?);
    }
    let now = Instant::now();
    let snap = KeeperSnap {
        protocol: HANDOFF_PROTOCOL,
        from_pid: std::process::id(),
        from_version: k.info.version.clone(),
        lock,
        sock,
        status: st.status.clone(),
        source: st.source.clone(),
        desired: st.desired.clone(),
        background: st.settings.background,
        windows,
        ever_attached: st.ever_attached,
        since_start_ms: now.duration_since(k.started).as_millis() as u64,
        since_detach_ms: now.duration_since(st.last_detach).as_millis() as u64,
        busy: st.busy,
        since_busy_ms: now.duration_since(st.last_busy).as_millis() as u64,
        swap: st.swap.clone(),
        keeps_agents: st.keeps_agents,
        door: door_snap,
        host: host_snap,
        children: children_snap,
        then_switch,
    };
    drop(st);
    let v = serde_json::to_value(&snap).map_err(|e| e.to_string())?;
    log(&format!("frozen: {} descriptors, {} buffers", pack.fds.len(), pack.blobs.len()));
    Ok((v, pack))
}

fn pack_door(pack: &mut Pack, d: DoorFreeze, token: &str) -> Result<DoorSnap, String> {
    let e = |e: std::io::Error| e.to_string();
    let listener = pack.fd(&d.listener).map_err(e)?;
    let mut relays = Vec::new();
    for (c, u) in &d.relays {
        relays.push((pack.fd(c).map_err(e)?, u.as_ref().map(|u| pack.fd(u)).transpose().map_err(e)?));
    }
    Ok(DoorSnap { listener, token: token.to_string(), target: d.target, relays })
}

/// Starts the new build's keeper with one end of a socketpair at its descriptor 3, in a session of
/// its own (like every keeper), its output to the same log as ours.
fn spawn_successor(k: &Keeper, exe: &Path, target: &BuildSource) -> std::io::Result<(Child, UnixStream)> {
    let (ours, theirs) = UnixStream::pair()?;
    let mut cmd = Command::new(exe);
    cmd.arg(KEEPER_FLAG).arg("--take-over-fd").arg("3").arg("--data-dir").arg(&k.data);
    if let Some(dir) = &target.host_dir {
        cmd.arg("--host-source").arg(dir);
    }
    if let Some(b) = &target.bundle_path {
        cmd.arg("--bundle-path").arg(b);
    }
    if let Some(v) = &target.version {
        cmd.arg("--app-version").arg(v);
    }
    // stdout and stderr are inherited: keeper.log, opened for append by the app that started the
    // first keeper.
    cmd.stdin(Stdio::null());
    let fd = theirs.as_raw_fd();
    // SAFETY: setsid, dup2 and fcntl are async-signal-safe, which is all pre_exec requires.
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if fd == 3 {
                // Already in place: only the close-on-exec flag has to go
                if libc::fcntl(3, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(fd, 3) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    drop(theirs);
    Ok((child, ours))
}

/// Everything the incoming keeper rebuilt before the commit, nothing running yet.
struct Prepared {
    snap: KeeperSnap,
    lock: std::fs::File,
    listener: UnixListener,
    door: super::front_door::PendingDoor,
    children: Option<children::Pending>,
    host: Option<ForeignAdopt>,
    windows: Vec<UnixStream>,
}

fn prepare(data: &Path, msg: wire::Message) -> Result<Prepared, String> {
    let snap_v = msg.header.get("snap").cloned().ok_or("no snapshot in the state message")?;
    let snap: KeeperSnap = serde_json::from_value(snap_v).map_err(|e| format!("snapshot: {e}"))?;
    if snap.protocol > HANDOFF_PROTOCOL {
        return Err(format!("handoff format {} is newer than this keeper reads ({HANDOFF_PROTOCOL})", snap.protocol));
    }
    let mut u = Unpack::new(msg.fds, msg.blobs);
    let lock = std::fs::File::from(u.fd(snap.lock)?);
    // The lock is held through the shared open file description; taking it again on that same
    // description succeeds, and proves this really is the keeper.lock the outgoing keeper holds.
    match sys::try_lock(&lock) {
        Ok(true) => {}
        Ok(false) => return Err("the passed keeper.lock is not the one held".into()),
        Err(e) => return Err(format!("cannot check keeper.lock: {e}")),
    }
    let listener = UnixListener::from(u.fd(snap.sock)?);
    let door_listener = std::net::TcpListener::from(u.fd(snap.door.listener)?);
    let mut relays = Vec::new();
    for (c, up) in &snap.door.relays {
        let client = std::net::TcpStream::from(u.fd(*c)?);
        let upstream = match up {
            Some(i) => Some(std::net::TcpStream::from(u.fd(*i)?)),
            None => None,
        };
        relays.push((client, upstream));
    }
    let door = FrontDoor::adopt(DoorFreeze { listener: door_listener, target: snap.door.target, relays }, snap.door.token.clone())
        .map_err(|e| format!("front door: {e}"))?;
    let children = match &snap.children {
        Some(c) => Some(Children::prepare(data, &c.state, &mut u.shifted((c.fd_base, c.blob_base)))?),
        None => None,
    };
    let host = match &snap.host {
        Some(h) => Some(ForeignAdopt {
            pid: h.pid,
            stdin: u.fd(h.stdin)?,
            stdout: u.fd(h.stdout)?,
            buffered: u.blob(h.buffered)?,
            info: h.info.clone(),
        }),
        None => None,
    };
    let mut windows = Vec::new();
    for i in &snap.windows {
        windows.push(UnixStream::from(u.fd(*i)?));
    }
    Ok(Prepared { snap, lock, listener, door, children, host, windows })
}

/// Whether a process is still there (the outgoing keeper, when the channel closed unexpectedly).
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// A test hook, read only by an incoming keeper: wait this long before saying ready, so a test
/// can kill it mid-handoff and watch the outgoing keeper roll back.
fn test_hold() -> Option<Duration> {
    std::env::var("CC_KEEPER_HANDOFF_HOLD_MS").ok()?.trim().parse::<u64>().ok().map(Duration::from_millis)
}

/// The incoming keeper's entry point (`--take-over-fd`). Returns the exit code.
pub(super) fn take(opts: Options, fd: RawFd) -> i32 {
    // SAFETY: descriptor 3 was put there for us by the outgoing keeper (spawn_successor).
    let mut ch = unsafe { UnixStream::from(OwnedFd::from_raw_fd(fd)) };
    // SAFETY: fcntl on our own descriptor; nothing we start later inherits the channel.
    unsafe { libc::fcntl(ch.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    match sys::peer_uid(&ch) {
        Ok(uid) if uid == sys::my_uid() => {}
        other => {
            log(&format!("refusing a handoff channel from another user ({other:?})"));
            return EXIT_ABORTED;
        }
    }
    let data = opts.data_dir.clone().unwrap_or_else(super::data_dir);
    let build = server::own_build(&opts);
    let hello = json!({
        "op": "hello",
        "protocol": HANDOFF_PROTOCOL,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
        "build": build,
    });
    if wire::send_op(&mut ch, &hello).is_err() {
        return EXIT_ABORTED;
    }
    let msg = match wire::recv(&mut ch, Duration::from_secs(60)) {
        Ok(m) if m.op() == "state" => m,
        Ok(m) => {
            log(&format!("the previous keeper sent {:?}; not taking over", m.op()));
            return EXIT_ABORTED;
        }
        Err(e) => {
            log(&format!("no state from the previous keeper ({e}); not taking over"));
            return EXIT_ABORTED;
        }
    };
    let prepared = match prepare(&data, msg) {
        Ok(p) => p,
        Err(why) => {
            log(&format!("cannot take over: {why}"));
            let _ = wire::send_op(&mut ch, &json!({ "op": "fail", "error": why }));
            return EXIT_ABORTED;
        }
    };
    if let Some(hold) = test_hold() {
        log(&format!("holding {}ms before ready (CC_KEEPER_HANDOFF_HOLD_MS)", hold.as_millis()));
        std::thread::sleep(hold);
    }
    if wire::send_op(&mut ch, &json!({ "op": "ready" })).is_err() {
        log("the previous keeper is gone before ready; not taking over");
        return EXIT_ABORTED;
    }
    let from = prepared.snap.from_pid;
    let reaped = match wire::recv(&mut ch, Duration::from_secs(30)) {
        Ok(m) if m.op() == "commit" => parse_reaped(m.header.get("reaped")),
        Ok(m) if m.op() == "abort" => {
            log("the previous keeper rolled back; exiting");
            return EXIT_ABORTED;
        }
        Ok(m) => {
            log(&format!("the previous keeper sent {:?} instead of commit; exiting", m.op()));
            return EXIT_ABORTED;
        }
        Err(e) => {
            // After ready the outgoing keeper only commits; the channel closing without a word
            // means it died. With it gone, this keeper holds the only copy of everything.
            if alive(from) {
                log(&format!("no commit ({e}) and the previous keeper is still running; exiting"));
                return EXIT_ABORTED;
            }
            log(&format!("no commit ({e}), and the previous keeper (pid {from}) is gone: taking over"));
            Vec::new()
        }
    };
    drop(ch);
    start(data, build, prepared, &reaped)
}

fn parse_reaped(v: Option<&Value>) -> Vec<(i32, ExitStatus)> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let pid = e.get(0)?.as_i64()? as i32;
                    let code = e.get(1).and_then(Value::as_i64).map(|c| c as i32);
                    let signal = e.get(2).and_then(Value::as_i64).map(|c| c as i32);
                    Some((pid, ExitStatus { code, signal }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Step 7: after the commit, everything starts.
fn start(data: PathBuf, build: BuildSource, p: Prepared, reaped: &[(i32, ExitStatus)]) -> i32 {
    let snap = p.snap;
    let children = match p.children {
        Some(c) => c.start(reaped).unwrap_or_else(|e| {
            log(&format!("could not start the child service ({e})"));
            Children::disabled()
        }),
        None => Children::disabled(),
    };
    let door = p.door.start();
    let now = Instant::now();
    let ago = |ms: u64| now.checked_sub(Duration::from_millis(ms)).unwrap_or(now);
    let settings = source::Settings { background: snap.background };
    let keeper = Arc::new(Keeper {
        info: KeeperInfo {
            pid: std::process::id(),
            protocol: KEEPER_PROTOCOL,
            version: env!("CARGO_PKG_VERSION").to_string(),
            started_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            data_dir: data.to_string_lossy().to_string(),
            build: Some(build),
        },
        sock: super::socket_path(&data),
        data,
        sup: Supervisor::new(),
        door,
        children,
        state: Mutex::new(State {
            status: snap.status.clone(),
            source: snap.source.clone(),
            desired: snap.desired.clone(),
            subscribers: Vec::new(),
            next_id: 1,
            attached: 0,
            ever_attached: snap.ever_attached,
            last_detach: ago(snap.since_detach_ms),
            busy: snap.busy,
            last_busy: ago(snap.since_busy_ms),
            settings,
            stopping: false,
            swap: snap.swap.clone(),
            swapping: snap.then_switch.is_some(),
            drained: None,
            keeps_agents: snap.keeps_agents,
        }),
        idle: super::idle_limit(),
        started: ago(snap.since_start_ms),
        lock: p.lock,
        listener: p.listener,
        frozen: AtomicBool::new(false),
        handed_over: AtomicBool::new(false),
        accept_parked: AtomicBool::new(false),
        requests: AtomicUsize::new(0),
    });
    server::record_lock_holder(&keeper.lock);
    for w in p.windows {
        server::adopt_window(&keeper, w);
    }
    if let Some(h) = p.host {
        let pid = h.pid;
        if let Err(e) = keeper.sup.adopt_foreign(h, server::sink(&keeper), server::launcher(&keeper)) {
            log(&format!("could not adopt the host (pid {pid}): {e}"));
        }
    } else if !matches!(snap.status, HostStatus::Failed { .. }) {
        // No host was running and none had given up: start one, as a fresh keeper would
        keeper.sup.start(server::sink(&keeper), server::launcher(&keeper));
    }
    server::log(&format!(
        "keeper {} took over from keeper pid {} ({}) (pid {}, front door {})",
        keeper.info.version,
        snap.from_pid,
        snap.from_version,
        keeper.info.pid,
        keeper.door.url()
    ));
    match snap.then_switch {
        Some(next) => {
            let k = keeper.clone();
            // A blue-green swap when the host is up (it is, normally), else a plain start of the
            // new build: the same decision a `switch` makes
            std::thread::spawn(move || server::begin_switch(k, next, None, None));
        }
        None => {
            if let Ok(mut st) = keeper.state.lock() {
                if let Some(sw) = st.swap.as_mut().filter(|s| s.phase == Phase::HandingOver) {
                    sw.phase = Phase::Done;
                }
                keeper.broadcast(&mut st);
            }
        }
    }
    keeper.write_state_file();
    server::serve(keeper)
}

#[cfg(test)]
mod tests;
