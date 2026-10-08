//! The keeper holds the long-lived children (#280, option C step 2).
//!
//! Agents (claude, codex app-server), terminals and project commands such as dev servers are
//! spawned by the keeper, not the host (owner decision 2; app MCP processes stay with the host).
//! A host that crashes, restarts or is switched to another build releases its connections and the
//! children keep running; the next host lists them and re-attaches mid-turn. Only an explicit
//! request from a live host — a session stop, a closed terminal — or the keeper's own stop ends
//! one.
//!
//! **Transport: `<data>/children.sock`**, a second unix socket beside `keeper.sock`, with the
//! same protections (created under `umask 077`, then `0600`, and every connection's peer uid must
//! be ours). It is separate because its traffic is different: `keeper.sock` is the app's door and
//! carries small JSON requests, this one carries the children's raw output. Each connection's first
//! line says what it is:
//!
//! | first line | then |
//! |---|---|
//! | `{"op":"hello","protocol":1}` | **control**: `{"ok":true,..}`, then requests `{"rid":n,"op":..}` answered `{"rid":n,"ok":..}`, and pushed events `{"event":"exit",..}` / `{"event":"stop"}` |
//! | `{"op":"attach","protocol":1,"id":"c3","stream":"out"\|"err"}` | `{"ok":true,"child":..}`, then **raw bytes**: the child's output to the host; the host's bytes to the child's stdin (or pty) |
//!
//! Control requests: `spawn`, `list`, `signal`, `close_stdin`, `resize`, `set_tag`, `release`
//! (see `Reactor::request`).
//!
//! **Attach and detach.** A new attach to a stream replaces the old reader. Buffered output is
//! flushed first (a pty replays what it kept), then output is live. A host that half-closes its
//! attach connection is detaching: it is sent the rest of the line it is in, then the keeper closes
//! the connection and buffers for the next host. A host that just disappears loses whatever was in
//! its socket; the next host starts on a line boundary (`buffer.rs`). **No connection closing ever
//! signals a child, closes its stdin or closes its pty**: that is what lets a host leave without
//! taking the agents with it. The Agent SDK, for one, kills its process when its owner exits; that
//! kill reaches this keeper only as an explicit `signal` request, and a detaching host never sends
//! it.
//!
//! **One thread owns everything.** Every descriptor (listener, children's pipes and pty masters,
//! connections, the exit watch) lives in the `Reactor`, driven by one `poll` loop that other
//! threads reach only through `Children` (a command queue plus a wake pipe). Each `Child` is plain
//! data plus its `OwnedFd`s, with no state hidden in a thread of its own, so a keeper upgrade
//! (step 4, `../handoff/`) serialises the table and passes the descriptors to the next keeper over
//! `SCM_RIGHTS`.
//!
//! **Handing the table over** (step 4). `freeze` makes the reactor finish its current pass, reap
//! what has exited, and then stop: it reads nothing more from any child or connection, writes
//! nothing, accepts nothing. Everything it had read but not yet delivered is in the snapshot
//! (`ReactorState`: buffers with their absolute offsets, half-read requests, unsent events), so
//! the next keeper starts exactly where this one stopped and **no byte is read twice or lost**
//! (the #280 measurement's rule: the outgoing keeper must not read ahead, or must forward what it
//! read). A rolled-back handoff `thaw`s the reactor, which carries on as if nothing happened: it
//! never closed or moved anything, the snapshot holds duplicates.

mod buffer;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use self::buffer::{BufState, OutBuf, Policy, LINES_CAP, RING_CAP, TAIL_CAP};
use super::handoff::pack::{Pack, Shifted};
use crate::os;
use crate::os::children as proc;
pub use crate::os::children::ExitStatus;

/// The child socket's protocol version. A host that speaks another one keeps its own children.
pub const CHILDREN_PROTOCOL: u32 = 1;

/// How long the keeper's stop waits for the host to stop its own children before it signals
/// them itself. The host's stop closes codex's stdin and gives claude the SDK's 2 s grace.
pub const HOST_STOP_WAIT: Duration = Duration::from_secs(6);

/// How long children get after stdin EOF / SIGHUP before TERM, when the keeper stops them itself.
pub const STOP_GRACE: Duration = Duration::from_secs(2);

/// How long what an agent left in its process group gets between the TERM sent as the agent exits
/// and the KILL (`Sweep`).
const SWEEP_GRACE: Duration = Duration::from_secs(2);

/// Bytes a host may queue for a child's stdin before the keeper stops reading the host.
const IN_CAP: usize = 8 * 1024 * 1024;
/// A control line longer than this is not a request.
const LINE_CAP: usize = 16 * 1024 * 1024;
/// A control connection that stops reading its events is dropped past this.
const CONTROL_OUT_CAP: usize = 8 * 1024 * 1024;
/// Exited children kept for a host that has not released them (a command's last log and exit
/// code survive a host restart this way). The oldest go first.
const MAX_EXITED: usize = 64;

pub fn socket_path(data: &Path) -> PathBuf {
    data.join("children.sock")
}

fn log(msg: &str) {
    eprintln!("[keeper] children: {msg}");
}

/// The handle the rest of the keeper holds. Cheap to clone; a disabled one does nothing.
#[derive(Clone)]
pub struct Children {
    shared: Option<Arc<Shared>>,
}

struct Shared {
    cmds: Mutex<Vec<Cmd>>,
    wake: OwnedFd,
    sock: PathBuf,
}

enum Cmd {
    AskHostStop(mpsc::Sender<()>),
    StopAll { grace: Duration, done: mpsc::Sender<()> },
    /// Stop all I/O and describe the table (step 4).
    Freeze(mpsc::Sender<Result<(Value, Pack), String>>),
    /// A handoff was rolled back: carry on.
    Thaw,
    /// Reap every child that has exited since the freeze and report it (the outgoing keeper is
    /// still their parent; the next one cannot reap them).
    Reap(mpsc::Sender<Vec<(i32, ExitStatus)>>),
}

impl Children {
    /// Binds `<data>/children.sock` and starts the reactor thread. Call it while the keeper is
    /// still single-threaded: the socket is created under a temporary `umask`.
    pub fn start(data: &Path) -> io::Result<Children> {
        let sock = socket_path(data);
        // Ours to replace: the caller holds keeper.lock.
        let _ = fs::remove_file(&sock);
        let listener = os::with_umask(0o077, || UnixListener::bind(&sock))?;
        let _ = fs::set_permissions(&sock, fs::Permissions::from_mode(0o600));
        listener.set_nonblocking(true)?;
        let (wake_r, wake_w) = pipe()?;
        let shared = Arc::new(Shared { cmds: Mutex::new(Vec::new()), wake: wake_w, sock: sock.clone() });
        let reactor = Reactor::new(listener, wake_r, shared.clone())?;
        thread::Builder::new().name("keeper-children".into()).spawn(move || reactor.run())?;
        log(&format!("listening on {}", sock.display()));
        Ok(Children { shared: Some(shared) })
    }

    /// A keeper whose child socket could not be bound: hosts fall back to spawning their own.
    pub fn disabled() -> Children {
        Children { shared: None }
    }

    fn send(&self, cmd: Cmd) -> bool {
        let Some(s) = &self.shared else { return false };
        let Ok(mut q) = s.cmds.lock() else { return false };
        q.push(cmd);
        drop(q);
        let _ = proc::write_fd(s.wake.as_raw_fd(), &[1]);
        true
    }

    /**
     * Asks the connected host to stop its sessions, terminals and commands the way it always did
     * (`{"event":"stop"}` on its control connection), and waits until it has hung up or `wait`
     * passes. Returns whether it did.
     *
     * The host, not the keeper, does the ordinary stop: it closes codex's stdin so codex removes
     * its thread lock (#57), gives claude the SDK's graceful close, walks process trees
     * (`kill-tree.ts`) and records the end of each session. `stop_all` is the backstop after it.
     */
    pub fn ask_host_to_stop(&self, wait: Duration) -> bool {
        let (tx, rx) = mpsc::channel();
        if !self.send(Cmd::AskHostStop(tx)) {
            return true;
        }
        rx.recv_timeout(wait).is_ok()
    }

    /**
     * Freezes the reactor for a keeper handoff (#280 step 4) and returns its table: plain data plus
     * the descriptors and buffers in a `Pack`. `Ok(None)` for a disabled service (nothing to hand
     * over). Refused while a stop is under way.
     */
    pub fn freeze(&self, wait: Duration) -> Result<Option<(Value, Pack)>, String> {
        let (tx, rx) = mpsc::channel();
        if !self.send(Cmd::Freeze(tx)) {
            return Ok(None);
        }
        rx.recv_timeout(wait).map_err(|_| "the child service did not freeze in time".to_string())?.map(Some)
    }

    /// Resumes a frozen reactor (the handoff was rolled back).
    pub fn thaw(&self) {
        self.send(Cmd::Thaw);
    }

    /// Reaps, while frozen, every child that exited since the freeze (#280 step 4, at the commit).
    pub fn reap_now(&self, wait: Duration) -> Vec<(i32, ExitStatus)> {
        let (tx, rx) = mpsc::channel();
        if !self.send(Cmd::Reap(tx)) {
            return Vec::new();
        }
        rx.recv_timeout(wait).unwrap_or_default()
    }

    /**
     * The receiving half of a handoff: rebuilds the table another keeper froze, **without starting
     * any I/O**. Nothing is read or written until `Pending::start`, which the new keeper calls only
     * after the commit, so a handoff that is rolled back leaves the outgoing keeper the sole reader.
     */
    pub fn prepare(data: &Path, state: &Value, unpack: &mut Shifted) -> Result<Pending, String> {
        let st: ReactorState = serde_json::from_value(state.clone()).map_err(|e| format!("child table: {e}"))?;
        let (wake_r, wake_w) = pipe().map_err(|e| e.to_string())?;
        let shared = Arc::new(Shared { cmds: Mutex::new(Vec::new()), wake: wake_w, sock: socket_path(data) });
        let reactor = Reactor::restore(st, unpack, wake_r, shared.clone())?;
        Ok(Pending { reactor, shared })
    }

    /// Ends every child still running: stdin EOF for pipes and SIGHUP for ptys, then after `grace`
    /// TERM to each child's group, then KILL. Returns once they are gone (with what exited agents
    /// left in their groups, `Sweep`) or the steps ran out; leftovers still waiting get KILL then.
    pub fn stop_all(&self, grace: Duration) {
        let (tx, rx) = mpsc::channel();
        if self.send(Cmd::StopAll { grace, done: tx }) {
            let _ = rx.recv_timeout(grace + Duration::from_secs(4));
        }
    }
}

/// A child table taken over from another keeper, not running yet.
pub struct Pending {
    reactor: Reactor,
    shared: Arc<Shared>,
}

impl Pending {
    /// Starts the reactor. `reaped` are the exit statuses the outgoing keeper collected at the
    /// commit, for children this keeper (not their parent) could not learn them for otherwise.
    pub fn start(mut self, reaped: &[(i32, ExitStatus)]) -> io::Result<Children> {
        for &(pid, st) in reaped {
            self.reactor.watch.know(pid, st);
        }
        let sock = self.shared.sock.clone();
        let reactor = self.reactor;
        thread::Builder::new().name("keeper-children".into()).spawn(move || reactor.run())?;
        log(&format!("took over {} from the previous keeper", sock.display()));
        Ok(Children { shared: Some(self.shared) })
    }
}

/// Reaps `pid` if it is this process's child and has exited (the host, at a handoff's commit).
pub fn reap_pid(pid: i32) -> Option<ExitStatus> {
    proc::try_reap(pid)
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: a valid two-element out array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: pipe just returned both.
    let (r, w) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in [&r, &w] {
        proc::set_cloexec(fd.as_raw_fd())?;
        proc::set_nonblocking(fd.as_raw_fd())?;
    }
    Ok((r, w))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Pipes,
    Pty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum Which {
    Out,
    Err,
}

/// One held child: what it is, its descriptors and its buffered output.
struct Child {
    kind: Kind,
    pid: i32,
    cmd: String,
    args: Vec<String>,
    cwd: String,
    started_ms: u64,
    /// The host's own description of the child (which session, terminal or command). Opaque here:
    /// the keeper stores it and hands it back, and parses nothing in it.
    tag: Value,
    cols: u16,
    rows: u16,
    /// Pipes only. A pty's input goes to `out_fd`, the master.
    stdin: Option<OwnedFd>,
    out_fd: Option<OwnedFd>,
    err_fd: Option<OwnedFd>,
    out: OutBuf,
    err: OutBuf,
    out_reader: Option<u64>,
    err_reader: Option<u64>,
    /// Bytes waiting for the child's stdin. Only whole lines enter it for pipes.
    inbuf: Vec<u8>,
    /// `close_stdin` was asked for: close it once `inbuf` is written.
    close_stdin: bool,
    exit: Option<ExitStatus>,
    exited_at: Option<Instant>,
}

impl Child {
    fn in_fd(&self) -> Option<RawFd> {
        match self.kind {
            Kind::Pty => self.out_fd.as_ref().map(|f| f.as_raw_fd()),
            Kind::Pipes => self.stdin.as_ref().map(|f| f.as_raw_fd()),
        }
    }

    fn buf(&mut self, w: Which) -> &mut OutBuf {
        match w {
            Which::Out => &mut self.out,
            Which::Err => &mut self.err,
        }
    }

    fn reader(&mut self, w: Which) -> &mut Option<u64> {
        match w {
            Which::Out => &mut self.out_reader,
            Which::Err => &mut self.err_reader,
        }
    }

    fn info(&self, n: u64) -> Value {
        json!({
            "id": child_id(n),
            "kind": match self.kind { Kind::Pipes => "pipes", Kind::Pty => "pty" },
            "pid": self.pid,
            "cmd": self.cmd,
            "args": self.args,
            "cwd": self.cwd,
            "startedAt": self.started_ms,
            "alive": self.exit.is_none(),
            "exit": self.exit,
            "tag": self.tag,
            "cols": self.cols,
            "rows": self.rows,
            "buffered": self.out.unsent(),
            "attached": self.out_reader.is_some(),
        })
    }
}

fn child_id(n: u64) -> String {
    format!("c{n}")
}

fn parse_child_id(v: Option<&Value>) -> Option<u64> {
    v?.as_str()?.strip_prefix('c')?.parse().ok()
}

enum Role {
    /// No first line yet.
    Hello,
    Control,
    Attach { child: u64, which: Which, detaching: bool },
}

struct Conn {
    stream: UnixStream,
    role: Role,
    rbuf: Vec<u8>,
    wbuf: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flush {
    Keep,
    /// Done with this reader on purpose (detached, or the stream ended and was all sent).
    Close,
    /// The reader is gone.
    Lost,
}

struct Stopping {
    phase: u8,
    deadline: Instant,
    done: Vec<mpsc::Sender<()>>,
}

/**
 * The process group of an agent that has exited, still to be swept (#350's rule: only that group).
 *
 * An agent CLI starts helpers of its own (Claude Code's LSP tool runs a language server, which runs
 * `tsserver`; MCP servers from the user's config; shells) and they share its group, which `setsid`
 * made the agent's own. A CLI that ends without stopping them (killed after a timeout, crashed, or
 * just not cleaning up) left them running under launchd/init. So when an agent exits, its group gets
 * TERM at once and, `SWEEP_GRACE` later, KILL for whatever is still there (`proc::signal_leftovers`).
 * Ptys are not swept: the kernel hangs up a terminal's foreground group as its shell exits, and the
 * host ends a terminal's or a command's whole tree when it stops one (`kill-tree.ts`).
 */
struct Sweep {
    pgid: i32,
    due: Instant,
}

#[derive(Clone, Copy)]
enum Tok {
    Listener,
    Wake,
    Exit,
    Out(u64),
    Err(u64),
    In(u64),
    Conn(u64),
}

struct Reactor {
    listener: UnixListener,
    wake: OwnedFd,
    shared: Arc<Shared>,
    watch: proc::ExitWatch,
    children: BTreeMap<u64, Child>,
    next_child: u64,
    conns: BTreeMap<u64, Conn>,
    next_conn: u64,
    host_stop_waiters: Vec<mpsc::Sender<()>>,
    stopping: Option<Stopping>,
    /// Groups of exited agents waiting for their KILL.
    sweeps: Vec<Sweep>,
    /// Frozen for a handoff: no I/O at all until thawed (step 4).
    frozen: bool,
}

/// The child table as one keeper hands it to the next (#280 step 4). Descriptors and buffers are
/// indices into the handoff message (`../handoff/pack.rs`).
#[derive(serde::Serialize, serde::Deserialize)]
struct ReactorState {
    listener: usize,
    next_child: u64,
    next_conn: u64,
    children: Vec<ChildState>,
    conns: Vec<ConnState>,
    /// Absent from an older keeper's table, and ignored by one: a sweep handed to it is lost, which
    /// is no worse than that keeper never sweeping.
    #[serde(default)]
    sweeps: Vec<SweepState>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SweepState {
    pgid: i32,
    due_in_ms: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ChildState {
    n: u64,
    kind: Kind,
    pid: i32,
    cmd: String,
    args: Vec<String>,
    cwd: String,
    started_ms: u64,
    tag: Value,
    cols: u16,
    rows: u16,
    stdin: Option<usize>,
    out_fd: Option<usize>,
    err_fd: Option<usize>,
    out: BufState,
    out_data: usize,
    err: BufState,
    err_data: usize,
    out_reader: Option<u64>,
    err_reader: Option<u64>,
    inbuf: usize,
    close_stdin: bool,
    exit: Option<ExitStatus>,
    /// How long ago it exited, so the oldest exited children still go first.
    exited_ms_ago: Option<u64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ConnState {
    id: u64,
    fd: usize,
    role: RoleState,
    rbuf: usize,
    wbuf: usize,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
enum RoleState {
    Hello,
    Control,
    Attach { child: u64, which: Which, detaching: bool },
}

impl Reactor {
    fn new(listener: UnixListener, wake: OwnedFd, shared: Arc<Shared>) -> io::Result<Self> {
        Ok(Reactor {
            listener,
            wake,
            shared,
            watch: proc::ExitWatch::new()?,
            children: BTreeMap::new(),
            next_child: 1,
            conns: BTreeMap::new(),
            next_conn: 1,
            host_stop_waiters: Vec::new(),
            stopping: None,
            sweeps: Vec::new(),
            frozen: false,
        })
    }

    /// Describes the whole table and stops all I/O (step 4). Called on the reactor thread, between
    /// two passes, so no request is half handled and no buffer half updated.
    fn freeze(&mut self) -> Result<(Value, Pack), String> {
        if self.stopping.is_some() || !self.host_stop_waiters.is_empty() {
            return Err("the child service is stopping".into());
        }
        // Whatever has exited is reaped now, while this keeper is still the parent; the snapshot
        // then carries the status.
        self.collect_exits();
        let mut pack = Pack::default();
        let e = |e: io::Error| e.to_string();
        let listener = pack.fd(&self.listener).map_err(e)?;
        let now = Instant::now();
        let mut children = Vec::new();
        for (&n, c) in &self.children {
            let (out, out_bytes) = c.out.save();
            let (err, err_bytes) = c.err.save();
            children.push(ChildState {
                n,
                kind: c.kind,
                pid: c.pid,
                cmd: c.cmd.clone(),
                args: c.args.clone(),
                cwd: c.cwd.clone(),
                started_ms: c.started_ms,
                tag: c.tag.clone(),
                cols: c.cols,
                rows: c.rows,
                stdin: c.stdin.as_ref().map(|f| pack.fd(f)).transpose().map_err(e)?,
                out_fd: c.out_fd.as_ref().map(|f| pack.fd(f)).transpose().map_err(e)?,
                err_fd: c.err_fd.as_ref().map(|f| pack.fd(f)).transpose().map_err(e)?,
                out,
                out_data: pack.blob(out_bytes),
                err,
                err_data: pack.blob(err_bytes),
                out_reader: c.out_reader,
                err_reader: c.err_reader,
                inbuf: pack.blob(c.inbuf.clone()),
                close_stdin: c.close_stdin,
                exit: c.exit,
                exited_ms_ago: c.exited_at.map(|t| now.duration_since(t).as_millis() as u64),
            });
        }
        let mut conns = Vec::new();
        for (&id, conn) in &self.conns {
            conns.push(ConnState {
                id,
                fd: pack.fd(&conn.stream).map_err(e)?,
                role: match conn.role {
                    Role::Hello => RoleState::Hello,
                    Role::Control => RoleState::Control,
                    Role::Attach { child, which, detaching } => RoleState::Attach { child, which, detaching },
                },
                rbuf: pack.blob(conn.rbuf.clone()),
                wbuf: pack.blob(conn.wbuf.clone()),
            });
        }
        let sweeps = self
            .sweeps
            .iter()
            .map(|s| SweepState { pgid: s.pgid, due_in_ms: s.due.saturating_duration_since(now).as_millis() as u64 })
            .collect();
        let st = ReactorState { listener, next_child: self.next_child, next_conn: self.next_conn, children, conns, sweeps };
        let v = serde_json::to_value(&st).map_err(|e| e.to_string())?;
        self.frozen = true;
        log(&format!("frozen for a handoff ({} children, {} connections)", st.children.len(), st.conns.len()));
        Ok((v, pack))
    }

    /// Rebuilds a table another keeper froze. Exit watches are registered here (passive); every
    /// read and write waits for `run`.
    fn restore(st: ReactorState, u: &mut Shifted, wake: OwnedFd, shared: Arc<Shared>) -> Result<Reactor, String> {
        let nb = |fd: &OwnedFd| proc::set_nonblocking(fd.as_raw_fd()).map_err(|e| e.to_string());
        let lfd = u.fd(st.listener)?;
        nb(&lfd)?;
        let listener = UnixListener::from(lfd);
        let mut r = Reactor::new(listener, wake, shared).map_err(|e| e.to_string())?;
        r.next_child = st.next_child;
        r.next_conn = st.next_conn;
        let now = Instant::now();
        r.sweeps = st.sweeps.iter().map(|s| Sweep { pgid: s.pgid, due: now + Duration::from_millis(s.due_in_ms) }).collect();
        for c in st.children {
            let mut take = |i: Option<usize>| -> Result<Option<OwnedFd>, String> {
                match i {
                    Some(i) => {
                        let fd = u.fd(i)?;
                        nb(&fd)?;
                        Ok(Some(fd))
                    }
                    None => Ok(None),
                }
            };
            let stdin = take(c.stdin)?;
            let out_fd = take(c.out_fd)?;
            let err_fd = take(c.err_fd)?;
            if c.exit.is_none() {
                r.watch.watch(c.pid);
            }
            let child = Child {
                kind: c.kind,
                pid: c.pid,
                cmd: c.cmd,
                args: c.args,
                cwd: c.cwd,
                started_ms: c.started_ms,
                tag: c.tag,
                cols: c.cols,
                rows: c.rows,
                stdin,
                out_fd,
                err_fd,
                out: OutBuf::restore(&c.out, u.blob(c.out_data)?),
                err: OutBuf::restore(&c.err, u.blob(c.err_data)?),
                out_reader: c.out_reader,
                err_reader: c.err_reader,
                inbuf: u.blob(c.inbuf)?,
                close_stdin: c.close_stdin,
                exit: c.exit,
                exited_at: c.exited_ms_ago.map(|ms| now.checked_sub(Duration::from_millis(ms)).unwrap_or(now)),
            };
            r.children.insert(c.n, child);
        }
        for c in st.conns {
            let fd = u.fd(c.fd)?;
            let stream = UnixStream::from(fd);
            stream.set_nonblocking(true).map_err(|e| e.to_string())?;
            let role = match c.role {
                RoleState::Hello => Role::Hello,
                RoleState::Control => Role::Control,
                RoleState::Attach { child, which, detaching } => Role::Attach { child, which, detaching },
            };
            r.conns.insert(c.id, Conn { stream, role, rbuf: u.blob(c.rbuf)?, wbuf: u.blob(c.wbuf)? });
        }
        Ok(r)
    }

    fn run(mut self) {
        loop {
            if self.frozen {
                // Only the command queue is listened to: a thaw, a reap, or nothing until the
                // process exits after a committed handoff.
                let mut p = libc::pollfd { fd: self.wake.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                // SAFETY: one valid pollfd.
                unsafe { libc::poll(&mut p, 1, 1000) };
                self.take_commands();
                continue;
            }
            let (mut fds, toks) = self.poll_set();
            let quick = self.stopping.is_some()
                || !self.host_stop_waiters.is_empty()
                || self.watch.polling()
                || !self.sweeps.is_empty();
            let timeout = if quick { 100 } else { 1000 };
            // SAFETY: fds is a valid array of fds.len() pollfd entries.
            let rc = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
            if rc < 0 {
                let e = io::Error::last_os_error();
                if e.kind() != io::ErrorKind::Interrupted {
                    log(&format!("poll failed: {e}"));
                    thread::sleep(Duration::from_millis(50));
                }
                continue;
            }
            for (i, p) in fds.iter().enumerate() {
                if p.revents == 0 {
                    continue;
                }
                match toks[i] {
                    Tok::Listener => self.accept(),
                    Tok::Wake => self.take_commands(),
                    Tok::Exit => {}
                    Tok::Out(n) => self.read_child(n, Which::Out),
                    Tok::Err(n) => self.read_child(n, Which::Err),
                    Tok::In(n) => self.write_child(n),
                    Tok::Conn(c) => self.read_conn(c),
                }
            }
            self.collect_exits();
            self.pump();
            self.housekeeping();
        }
    }

    fn poll_set(&self) -> (Vec<libc::pollfd>, Vec<Tok>) {
        let mut fds = Vec::new();
        let mut toks = Vec::new();
        let mut add = |fd: RawFd, events: libc::c_short, t: Tok| {
            fds.push(libc::pollfd { fd, events, revents: 0 });
            toks.push(t);
        };
        add(self.listener.as_raw_fd(), libc::POLLIN, Tok::Listener);
        add(self.wake.as_raw_fd(), libc::POLLIN, Tok::Wake);
        for fd in self.watch.fds() {
            add(fd, libc::POLLIN, Tok::Exit);
        }
        for (&n, c) in &self.children {
            // Only streams with room are polled: a full agent stdout is left to fill its pipe, and
            // a descriptor polled for nothing would spin on POLLHUP.
            if let Some(fd) = &c.out_fd {
                if c.out.wants_input() {
                    add(fd.as_raw_fd(), libc::POLLIN, Tok::Out(n));
                }
            }
            if let Some(fd) = &c.err_fd {
                add(fd.as_raw_fd(), libc::POLLIN, Tok::Err(n));
            }
            if let Some(fd) = c.in_fd() {
                if !c.inbuf.is_empty() {
                    add(fd, libc::POLLOUT, Tok::In(n));
                }
            }
        }
        for (&id, conn) in &self.conns {
            let mut ev: libc::c_short = 0;
            let mut want_out = !conn.wbuf.is_empty();
            match conn.role {
                Role::Attach { child, which, detaching } => {
                    if let Some(c) = self.children.get(&child) {
                        let room = c.inbuf.len() < IN_CAP && conn.rbuf.len() < IN_CAP;
                        if room {
                            ev |= libc::POLLIN;
                        }
                        let b = match which {
                            Which::Out => &c.out,
                            Which::Err => &c.err,
                        };
                        if !b.sendable(detaching).is_empty() {
                            want_out = true;
                        }
                    }
                }
                _ => ev |= libc::POLLIN,
            }
            if want_out {
                ev |= libc::POLLOUT;
            }
            add(conn.stream.as_raw_fd(), ev, Tok::Conn(id));
        }
        (fds, toks)
    }

    fn take_commands(&mut self) {
        let mut b = [0u8; 64];
        while matches!(proc::read_fd(self.wake.as_raw_fd(), &mut b), Ok(n) if n > 0) {}
        let cmds = match self.shared.cmds.lock() {
            Ok(mut q) => std::mem::take(&mut *q),
            Err(_) => return,
        };
        for cmd in cmds {
            match cmd {
                Cmd::AskHostStop(done) => {
                    let line = event_line(&json!({ "event": "stop" }));
                    let mut any = false;
                    for conn in self.conns.values_mut() {
                        if let Role::Control = conn.role {
                            conn.wbuf.extend_from_slice(&line);
                            any = true;
                        }
                    }
                    log(if any { "asked the host to stop its children" } else { "no host connected to stop its children" });
                    self.host_stop_waiters.push(done);
                }
                Cmd::Freeze(reply) => {
                    let r = if self.frozen { Err("already frozen".to_string()) } else { self.freeze() };
                    let _ = reply.send(r);
                }
                Cmd::Thaw => {
                    if self.frozen {
                        self.frozen = false;
                        log("thawed: the handoff was rolled back");
                    }
                }
                Cmd::Reap(reply) => {
                    let mut reaped = Vec::new();
                    for c in self.children.values_mut().filter(|c| c.exit.is_none()) {
                        if let Some(st) = proc::try_reap(c.pid) {
                            c.exit = Some(st);
                            c.exited_at = Some(Instant::now());
                            reaped.push((c.pid, st));
                        }
                    }
                    let _ = reply.send(reaped);
                }
                Cmd::StopAll { grace, done } => match &mut self.stopping {
                    Some(s) => s.done.push(done),
                    None => {
                        let live = self.children.values().filter(|c| c.exit.is_none()).count();
                        if live > 0 {
                            log(&format!("stopping {live} children still running"));
                        }
                        for c in self.children.values_mut().filter(|c| c.exit.is_none()) {
                            match c.kind {
                                // EOF first: codex removes its thread lock on stdin EOF but not on TERM (#57).
                                Kind::Pipes => {
                                    c.inbuf.clear();
                                    c.stdin = None;
                                }
                                Kind::Pty => {
                                    let _ = proc::signal(c.pid, libc::SIGHUP, true);
                                }
                            }
                        }
                        self.stopping = Some(Stopping { phase: 0, deadline: Instant::now() + grace, done: vec![done] });
                    }
                },
            }
        }
    }

    fn accept(&mut self) {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Err(who) = os::peer_is_this_user(&stream) {
                        log(&format!("refused a connection from another user ({who})"));
                        continue;
                    }
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    let id = self.next_conn;
                    self.next_conn += 1;
                    self.conns.insert(id, Conn { stream, role: Role::Hello, rbuf: Vec::new(), wbuf: Vec::new() });
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return,
                Err(e) => {
                    log(&format!("accept failed: {e}"));
                    return;
                }
            }
        }
    }

    fn read_child(&mut self, n: u64, which: Which) {
        let Some(c) = self.children.get_mut(&n) else { return };
        let fd = match which {
            Which::Out => c.out_fd.as_ref().map(|f| f.as_raw_fd()),
            Which::Err => c.err_fd.as_ref().map(|f| f.as_raw_fd()),
        };
        let Some(fd) = fd else { return };
        let mut tmp = vec![0u8; 64 * 1024];
        let mut eof = false;
        // Bounded per wakeup so one chatty child cannot starve the others.
        for _ in 0..16 {
            if !c.buf(which).wants_input() {
                break;
            }
            match proc::read_fd(fd, &mut tmp) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(k) => c.buf(which).push(&tmp[..k]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // EIO: a pty master whose slave side is all closed. Anything else: the same end.
                Err(_) => {
                    eof = true;
                    break;
                }
            }
        }
        if eof {
            c.buf(which).eof = true;
            match which {
                Which::Out => c.out_fd = None,
                Which::Err => c.err_fd = None,
            }
        }
    }

    fn write_child(&mut self, n: u64) {
        let Some(c) = self.children.get_mut(&n) else { return };
        write_inbuf(c);
    }

    fn read_conn(&mut self, id: u64) {
        let Some(conn) = self.conns.get_mut(&id) else { return };
        let mut tmp = vec![0u8; 64 * 1024];
        let mut eof = false;
        let mut lost = false;
        for _ in 0..16 {
            match conn.stream.read(&mut tmp) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(k) => {
                    conn.rbuf.extend_from_slice(&tmp[..k]);
                    if conn.rbuf.len() >= IN_CAP {
                        break;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    lost = true;
                    break;
                }
            }
        }
        if lost {
            return self.drop_conn(id, Flush::Lost);
        }
        self.process_input(id);
        // What a burst left behind once it was taken: up to IN_CAP for an attach, LINE_CAP for a
        // control line (#392).
        if let Some(conn) = self.conns.get_mut(&id) {
            buffer::give_back(&mut conn.rbuf);
        }
        if eof {
            match self.conns.get_mut(&id).map(|c| &mut c.role) {
                // The host half-closed: it is detaching. Send what it is owed, then close.
                Some(Role::Attach { detaching, .. }) => *detaching = true,
                Some(_) => self.drop_conn(id, Flush::Close),
                None => {}
            }
        }
    }

    /// Acts on what a connection has sent so far.
    fn process_input(&mut self, id: u64) {
        loop {
            let Some(conn) = self.conns.get_mut(&id) else { return };
            match conn.role {
                Role::Attach { child, which, .. } => {
                    let Some(c) = self.children.get_mut(&child) else { return };
                    attach_input(c, which, &mut conn.rbuf);
                    return;
                }
                Role::Hello | Role::Control => {
                    let Some(nl) = conn.rbuf.iter().position(|&b| b == b'\n') else {
                        if conn.rbuf.len() > LINE_CAP {
                            self.drop_conn(id, Flush::Close);
                        }
                        return;
                    };
                    let line: Vec<u8> = conn.rbuf.drain(..=nl).collect();
                    let req: Value = match serde_json::from_slice(&line) {
                        Ok(v) => v,
                        Err(e) => {
                            let r = json!({ "ok": false, "error": format!("not JSON: {e}") });
                            conn.wbuf.extend_from_slice(&event_line(&r));
                            continue;
                        }
                    };
                    let is_hello = matches!(conn.role, Role::Hello);
                    if is_hello {
                        self.handshake(id, &req);
                    } else {
                        let mut resp = self.request(&req);
                        if let Some(rid) = req.get("rid") {
                            resp["rid"] = rid.clone();
                        }
                        if let Some(conn) = self.conns.get_mut(&id) {
                            conn.wbuf.extend_from_slice(&event_line(&resp));
                        }
                    }
                }
            }
        }
    }

    fn handshake(&mut self, id: u64, req: &Value) {
        let protocol = req.get("protocol").and_then(Value::as_u64).unwrap_or(0);
        let op = req.get("op").and_then(Value::as_str).unwrap_or("");
        let refuse = |me: &mut Self, msg: String| {
            if let Some(conn) = me.conns.get_mut(&id) {
                conn.wbuf.extend_from_slice(&event_line(&json!({ "ok": false, "error": msg })));
                let _ = flush_raw(&mut conn.stream, &mut conn.wbuf);
            }
            me.drop_conn(id, Flush::Close);
        };
        if protocol != CHILDREN_PROTOCOL as u64 {
            return refuse(self, format!("children protocol mismatch (keeper {CHILDREN_PROTOCOL}, host {protocol})"));
        }
        match op {
            "hello" => {
                if let Some(conn) = self.conns.get_mut(&id) {
                    conn.role = Role::Control;
                    let r = json!({ "ok": true, "protocol": CHILDREN_PROTOCOL, "keeperPid": std::process::id() });
                    conn.wbuf.extend_from_slice(&event_line(&r));
                }
            }
            "attach" => {
                let Some(n) = parse_child_id(req.get("id")) else {
                    return refuse(self, "attach needs an id".into());
                };
                let which = match req.get("stream").and_then(Value::as_str).unwrap_or("out") {
                    "out" => Which::Out,
                    "err" => Which::Err,
                    s => return refuse(self, format!("unknown stream {s:?}")),
                };
                let Some(c) = self.children.get_mut(&n) else {
                    return refuse(self, format!("no child {}", child_id(n)));
                };
                if which == Which::Err && c.kind == Kind::Pty {
                    return refuse(self, "a pty has no separate stderr".into());
                }
                let old = c.reader(which).replace(id);
                c.buf(which).attached();
                let info = c.info(n);
                if let Some(conn) = self.conns.get_mut(&id) {
                    conn.role = Role::Attach { child: n, which, detaching: false };
                    conn.wbuf.extend_from_slice(&event_line(&json!({ "ok": true, "child": info })));
                }
                // The previous reader, if it is still there, is a host that has been replaced.
                if let Some(old) = old.filter(|&o| o != id) {
                    if let Some(conn) = self.conns.remove(&old) {
                        let _ = conn.stream.shutdown(Shutdown::Both);
                    }
                }
            }
            other => refuse(self, format!("unknown first op {other:?}")),
        }
    }

    /// One control request. Every answer carries `ok`.
    fn request(&mut self, req: &Value) -> Value {
        let op = req.get("op").and_then(Value::as_str).unwrap_or("");
        let fail = |msg: String| json!({ "ok": false, "error": msg });
        match op {
            "list" => {
                let list: Vec<Value> = self.children.iter().map(|(&n, c)| c.info(n)).collect();
                json!({ "ok": true, "children": list })
            }
            "spawn" => match self.spawn(req) {
                Ok(v) => json!({ "ok": true, "child": v }),
                Err(e) => fail(e),
            },
            "signal" => {
                let Some(n) = parse_child_id(req.get("id")) else { return fail("signal needs an id".into()) };
                let Some(c) = self.children.get(&n) else { return fail(format!("no child {}", child_id(n))) };
                let name = req.get("signal").and_then(Value::as_str).unwrap_or("SIGTERM");
                let Some(sig) = proc::signal_number(name) else { return fail(format!("signal {name:?} is not allowed")) };
                // An exited child's pid may already belong to someone else.
                if c.exit.is_some() {
                    return json!({ "ok": true, "exited": true });
                }
                let group = req.get("group").and_then(Value::as_bool).unwrap_or(false);
                match proc::signal(c.pid, sig, group) {
                    Ok(()) => json!({ "ok": true }),
                    Err(e) => fail(format!("signal failed: {e}")),
                }
            }
            "close_stdin" => {
                let Some(n) = parse_child_id(req.get("id")) else { return fail("close_stdin needs an id".into()) };
                let Some(c) = self.children.get_mut(&n) else { return fail(format!("no child {}", child_id(n))) };
                if c.kind != Kind::Pipes {
                    return fail("a pty has no stdin of its own to close".into());
                }
                c.close_stdin = true;
                if c.inbuf.is_empty() {
                    c.stdin = None;
                }
                json!({ "ok": true })
            }
            "resize" => {
                let Some(n) = parse_child_id(req.get("id")) else { return fail("resize needs an id".into()) };
                let Some(c) = self.children.get_mut(&n) else { return fail(format!("no child {}", child_id(n))) };
                let cols = req.get("cols").and_then(Value::as_u64).unwrap_or(0).min(u16::MAX as u64) as u16;
                let rows = req.get("rows").and_then(Value::as_u64).unwrap_or(0).min(u16::MAX as u64) as u16;
                if c.kind != Kind::Pty || cols < 2 || rows < 2 {
                    return fail("resize needs a pty and a size of at least 2x2".into());
                }
                let Some(fd) = c.out_fd.as_ref().map(|f| f.as_raw_fd()) else { return json!({ "ok": true, "exited": true }) };
                match proc::resize(fd, cols, rows) {
                    Ok(()) => {
                        c.cols = cols;
                        c.rows = rows;
                        json!({ "ok": true })
                    }
                    Err(e) => fail(format!("resize failed: {e}")),
                }
            }
            "set_tag" => {
                let Some(n) = parse_child_id(req.get("id")) else { return fail("set_tag needs an id".into()) };
                let Some(c) = self.children.get_mut(&n) else { return fail(format!("no child {}", child_id(n))) };
                c.tag = req.get("tag").cloned().unwrap_or(Value::Null);
                json!({ "ok": true })
            }
            "release" => {
                let Some(n) = parse_child_id(req.get("id")) else { return fail("release needs an id".into()) };
                match self.children.get(&n) {
                    None => json!({ "ok": true }),
                    Some(c) if c.exit.is_none() => fail("still running: signal it first".into()),
                    Some(_) => {
                        self.remove_child(n);
                        json!({ "ok": true })
                    }
                }
            }
            _ => fail(format!("unknown op {op:?}")),
        }
    }

    fn spawn(&mut self, req: &Value) -> Result<Value, String> {
        let kind = match req.get("kind").and_then(Value::as_str) {
            Some("pipes") => Kind::Pipes,
            Some("pty") => Kind::Pty,
            other => return Err(format!("unknown kind {other:?}")),
        };
        let cmd = req.get("cmd").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("spawn needs a cmd")?;
        let args: Vec<String> = req
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let cwd = req.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("spawn needs a cwd")?;
        let env: HashMap<String, String> = req
            .get("env")
            .and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        let cols = req.get("cols").and_then(Value::as_u64).unwrap_or(80).clamp(2, u16::MAX as u64) as u16;
        let rows = req.get("rows").and_then(Value::as_u64).unwrap_or(24).clamp(2, u16::MAX as u64) as u16;
        let program = proc::resolve_program(cmd, &env);
        let s = match kind {
            Kind::Pipes => proc::spawn_pipes(&program, &args, cwd, &env),
            Kind::Pty => proc::spawn_pty(&program, &args, cwd, &env, cols, rows),
        }
        .map_err(|e| format!("could not start {cmd}: {e}"))?;
        let n = self.next_child;
        self.next_child += 1;
        self.watch.watch(s.pid);
        let started_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let mut err = OutBuf::new(Policy::Tail { cap: TAIL_CAP });
        if s.err.is_none() {
            err.eof = true;
        }
        let c = Child {
            kind,
            pid: s.pid,
            cmd: program,
            args,
            cwd: cwd.to_string(),
            started_ms,
            tag: req.get("tag").cloned().unwrap_or(Value::Null),
            cols,
            rows,
            stdin: s.stdin,
            out_fd: Some(s.out),
            err_fd: s.err,
            out: OutBuf::new(match kind {
                Kind::Pipes => Policy::Lines { cap: LINES_CAP },
                Kind::Pty => Policy::Ring { cap: RING_CAP },
            }),
            err,
            out_reader: None,
            err_reader: None,
            inbuf: Vec::new(),
            close_stdin: false,
            exit: None,
            exited_at: None,
        };
        log(&format!("{} started pid {} ({}) {}", child_id(n), c.pid, if kind == Kind::Pty { "pty" } else { "pipes" }, c.cmd));
        let info = c.info(n);
        self.children.insert(n, c);
        Ok(info)
    }

    fn remove_child(&mut self, n: u64) {
        let Some(c) = self.children.remove(&n) else { return };
        for id in [c.out_reader, c.err_reader].into_iter().flatten() {
            if let Some(conn) = self.conns.remove(&id) {
                let _ = conn.stream.shutdown(Shutdown::Both);
            }
        }
    }

    fn drop_conn(&mut self, id: u64, how: Flush) {
        let Some(conn) = self.conns.remove(&id) else { return };
        if how == Flush::Close {
            let _ = conn.stream.shutdown(Shutdown::Write);
        }
        if let Role::Attach { child, which, .. } = conn.role {
            if let Some(c) = self.children.get_mut(&child) {
                if *c.reader(which) == Some(id) {
                    *c.reader(which) = None;
                    if how == Flush::Lost {
                        c.buf(which).reader_lost();
                    }
                }
            }
        }
    }

    fn collect_exits(&mut self) {
        for (pid, st) in self.watch.collect() {
            let Some((&n, c)) = self.children.iter_mut().find(|(_, c)| c.pid == pid && c.exit.is_none()) else {
                continue;
            };
            c.exit = Some(st);
            c.exited_at = Some(Instant::now());
            log(&format!("{} pid {pid} exited (code {:?}, signal {:?})", child_id(n), st.code, st.signal));
            if c.kind == Kind::Pipes {
                if proc::signal_leftovers(pid, libc::SIGTERM) {
                    log(&format!("{}: TERM to what it left in its process group", child_id(n)));
                }
                self.sweeps.push(Sweep { pgid: pid, due: Instant::now() + SWEEP_GRACE });
            }
            let line = event_line(&json!({ "event": "exit", "id": child_id(n), "code": st.code, "signal": st.signal }));
            for conn in self.conns.values_mut() {
                if let Role::Control = conn.role {
                    conn.wbuf.extend_from_slice(&line);
                }
            }
        }
    }

    /// Moves every byte that can move: into children's stdin, out to readers and control
    /// connections.
    fn pump(&mut self) {
        for c in self.children.values_mut() {
            write_inbuf(c);
        }
        let ids: Vec<u64> = self.conns.keys().copied().collect();
        for id in ids {
            let r = self.flush_conn(id);
            if r != Flush::Keep {
                self.drop_conn(id, r);
            }
        }
    }

    fn flush_conn(&mut self, id: u64) -> Flush {
        let Some(conn) = self.conns.get_mut(&id) else { return Flush::Keep };
        let flushed = match flush_raw(&mut conn.stream, &mut conn.wbuf) {
            Ok(all) => all,
            Err(_) => return Flush::Lost,
        };
        buffer::give_back(&mut conn.wbuf);
        /*
         * The cap is checked whether or not the socket took everything (#392). Checked only after a
         * flush that emptied the queue, it could never fire: a host or client that stops reading is
         * exactly the one whose flush never completes, and its replies and exit events queued without
         * bound.
         */
        if !matches!(conn.role, Role::Attach { .. }) && conn.wbuf.len() > CONTROL_OUT_CAP {
            // Never silent: a host whose control connection goes sees every child it holds exit
            // with SIGHUP and cannot spawn until it restarts.
            let role = if matches!(conn.role, Role::Control) { "control" } else { "hello" };
            log(&format!(
                "dropped {role} connection {id}: {} bytes queued past the {CONTROL_OUT_CAP}-byte cap, its peer is not reading",
                conn.wbuf.len()
            ));
            return Flush::Lost;
        }
        if !flushed {
            return Flush::Keep;
        }
        let Role::Attach { child, which, detaching } = conn.role else { return Flush::Keep };
        let Some(c) = self.children.get_mut(&child) else { return Flush::Close };
        if *c.reader(which) != Some(id) {
            return Flush::Close;
        }
        let b = c.buf(which);
        loop {
            let chunk = b.sendable(detaching);
            if chunk.is_empty() {
                break;
            }
            let len = chunk.len();
            match conn.stream.write(chunk) {
                Ok(0) => return Flush::Lost,
                Ok(k) => {
                    b.sent(k);
                    if k < len {
                        return Flush::Keep;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Flush::Keep,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Flush::Lost,
            }
        }
        if (detaching && b.at_boundary()) || b.drained() {
            return Flush::Close;
        }
        Flush::Keep
    }

    /// KILL to the groups whose grace has run out; groups that emptied are forgotten.
    fn sweep(&mut self) {
        let now = Instant::now();
        self.sweeps.retain(|s| {
            if !proc::group_exists(s.pgid) {
                return false;
            }
            if now < s.due {
                return true;
            }
            if proc::signal_leftovers(s.pgid, libc::SIGKILL) {
                log(&format!("KILL to what pid {} left in its process group", s.pgid));
            }
            false
        });
    }

    fn housekeeping(&mut self) {
        // A host asked to stop has finished once no control connection is left.
        if !self.host_stop_waiters.is_empty() && !self.conns.values().any(|c| matches!(c.role, Role::Control)) {
            for w in self.host_stop_waiters.drain(..) {
                let _ = w.send(());
            }
        }
        self.sweep();
        if let Some(s) = &mut self.stopping {
            let live: Vec<i32> = self.children.values().filter(|c| c.exit.is_none()).map(|c| c.pid).collect();
            let now = Instant::now();
            let given_up = s.phase >= 2 && now >= s.deadline;
            if (live.is_empty() && self.sweeps.is_empty()) || given_up {
                if !live.is_empty() {
                    log(&format!("{} children did not exit after KILL", live.len()));
                }
                // Nothing runs after this keeper to sweep later: what agents left gets its KILL now.
                for sw in self.sweeps.drain(..) {
                    proc::signal_leftovers(sw.pgid, libc::SIGKILL);
                }
                let _ = fs::remove_file(&self.shared.sock);
                for d in s.done.drain(..) {
                    let _ = d.send(());
                }
                self.stopping = None;
            } else if now >= s.deadline {
                let sig = if s.phase == 0 { libc::SIGTERM } else { libc::SIGKILL };
                for pid in live {
                    let _ = proc::signal(pid, sig, true);
                }
                s.phase += 1;
                s.deadline = now + Duration::from_secs(1);
            }
        }
        let exited: Vec<(Instant, u64)> =
            self.children.iter().filter_map(|(&n, c)| c.exited_at.map(|t| (t, n))).collect();
        if exited.len() > MAX_EXITED {
            let over = exited.len() - MAX_EXITED;
            let mut exited = exited;
            exited.sort();
            for (_, n) in exited.into_iter().take(over) {
                self.remove_child(n);
            }
        }
    }
}

/// Moves a connection's bytes into the child's input. Only whole lines go to an agent's stdin, so
/// a host that dies half way through writing a request never leaves claude or codex a torn line.
fn attach_input(c: &mut Child, which: Which, rbuf: &mut Vec<u8>) {
    if which == Which::Err || c.in_fd().is_none() || c.exit.is_some() {
        rbuf.clear();
        return;
    }
    let room = IN_CAP.saturating_sub(c.inbuf.len());
    if room == 0 {
        return;
    }
    match c.kind {
        Kind::Pty => {
            let k = rbuf.len().min(room);
            c.inbuf.extend(rbuf.drain(..k));
        }
        Kind::Pipes => match rbuf.iter().rposition(|&b| b == b'\n') {
            Some(i) => c.inbuf.extend(rbuf.drain(..=i)),
            // A single line longer than the cap would otherwise wait forever.
            None if rbuf.len() >= IN_CAP => c.inbuf.append(rbuf),
            None => {}
        },
    }
}

fn write_inbuf(c: &mut Child) {
    let Some(fd) = c.in_fd() else {
        c.inbuf.clear();
        return;
    };
    while !c.inbuf.is_empty() {
        match proc::write_fd(fd, &c.inbuf) {
            Ok(0) => break,
            Ok(k) => {
                c.inbuf.drain(..k);
                buffer::give_back(&mut c.inbuf);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            // EPIPE: the child is not reading any more.
            Err(_) => {
                c.inbuf.clear();
                if c.kind == Kind::Pipes {
                    c.stdin = None;
                }
                break;
            }
        }
    }
    if c.inbuf.is_empty() && c.close_stdin && c.kind == Kind::Pipes {
        c.stdin = None;
    }
}

/// Writes as much of `wbuf` as the socket takes. `Ok(true)`: all of it.
fn flush_raw(stream: &mut UnixStream, wbuf: &mut Vec<u8>) -> io::Result<bool> {
    while !wbuf.is_empty() {
        match stream.write(wbuf) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(k) => {
                wbuf.drain(..k);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

fn event_line(v: &Value) -> Vec<u8> {
    let mut l = serde_json::to_vec(v).unwrap_or_default();
    l.push(b'\n');
    l
}

#[cfg(test)]
mod tests;
