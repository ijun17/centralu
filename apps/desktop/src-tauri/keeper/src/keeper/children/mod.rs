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
//!
//! **Files.** This one: the handle (`Children`) and what other threads send the reactor.
//! `child.rs`: one child and the bytes into it. `reactor.rs`: the poll loop, accepting and moving
//! bytes. `requests.rs`: the first line and the control requests. `stop.rs`: sweeps and the stop.
//! `snapshot.rs`: freezing and rebuilding the table for a handoff. `buffer.rs`: the output buffers.

mod buffer;
mod child;
mod reactor;
mod requests;
mod snapshot;
mod stop;

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
use super::accept::{self, AcceptErrors};
use super::client::json_line;
use super::handoff::pack::{Pack, Shifted};
use crate::os;
use crate::os::children as proc;
pub use crate::os::children::ExitStatus;

use self::child::*;
use self::reactor::*;
use self::snapshot::*;
use self::stop::*;

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
    /// Who the socket answers (#538): the hosts this keeper holds.
    hosts: Mutex<Hosts>,
}

/**
 * The processes the child socket answers (#538, issue's option B): the current host, which the
 * keeper's supervisor names (`current`), and a swap's standby while it is one, by their exact pid.
 * Through this socket a process can start any program and read every agent's stream; the uid check
 * alone let every process of this user in. Nothing is answered until the keeper says who its host is.
 */
#[derive(Default)]
struct Hosts {
    current: Option<Arc<dyn Fn() -> Option<u32> + Send + Sync>>,
    standby: Option<u32>,
    /// At a handoff (#280 step 4), the host the previous keeper passed on, from the first accept until
    /// this keeper's supervisor has adopted it and names it itself (`Children::adopted`).
    handed: Option<u32>,
}

impl Shared {
    /// Whether the process at the other end of `stream` is a host this keeper holds, by its exact pid.
    /// Said in the log when it is not.
    fn answers(&self, stream: &std::os::unix::net::UnixStream) -> bool {
        let pid = match os::peer_pid(stream) {
            Ok(pid) => pid,
            Err(e) => {
                log(&format!("refused a connection: cannot tell which process it is ({e})"));
                return false;
            }
        };
        let held: Vec<u32> = match self.hosts.lock() {
            Ok(h) => h.current.as_ref().and_then(|f| f()).into_iter().chain(h.standby).chain(h.handed).collect(),
            Err(_) => Vec::new(),
        };
        if is_a_host(pid, &held) {
            return true;
        }
        log(&format!(
            "refused a connection from pid {pid}: not a host this keeper holds ({})",
            if held.is_empty() { "it names none yet".to_string() } else { format!("it holds {held:?}") }
        ));
        false
    }
}

/**
 * `Shared::answers`'s rule, apart from the kernel: the peer `pid` is one of the hosts in `held`.
 * Exactly the host, not its process group: `spawn_host` makes the host lead a group, and what it runs
 * without a session of its own (a worktree's setup command, `npm install -g`, a version probe) is in
 * that group too. A setup script an agent changed could then have connected here and started anything
 * (review of #1100). A host run from source is one process for this reason (`source_launch`).
 */
pub(super) fn is_a_host(pid: u32, held: &[u32]) -> bool {
    held.contains(&pid)
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
    /// What the keeper holds, as the child socket's `list` says it (`keeper.sock` `children`).
    List(mpsc::Sender<Vec<Value>>),
    /// Tests only: before its next `poll`, the reactor waits until a command is queued and every
    /// child's stdout has bytes waiting, so both are ready in the same pass (#368).
    #[cfg(test)]
    HoldNextPoll(mpsc::Sender<()>),
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
        let shared = Arc::new(Shared { cmds: Mutex::new(Vec::new()), wake: wake_w, sock: sock.clone(), hosts: Mutex::default() });
        Reactor::new(listener, wake_r, shared.clone())?.start()?;
        log(&format!("listening on {}", sock.display()));
        Ok(Children { shared: Some(shared) })
    }

    /// A keeper whose child socket could not be bound: hosts fall back to spawning their own.
    pub fn disabled() -> Children {
        Children { shared: None }
    }

    /// Who the current host is, asked on every connection: the socket answers it, and a standby
    /// (`set_standby`), and no other process (#538).
    pub fn answer_hosts(&self, current: Arc<dyn Fn() -> Option<u32> + Send + Sync>) {
        if let Some(Ok(mut h)) = self.shared.as_ref().map(|s| s.hosts.lock()) {
            h.current = Some(current);
        }
    }

    /// The host handed over with this keeper has been adopted: the supervisor names it from now on.
    pub fn adopted(&self) {
        if let Some(Ok(mut h)) = self.shared.as_ref().map(|s| s.hosts.lock()) {
            h.handed = None;
        }
    }

    /// A swap's standby host while it is one, None once the swap is over.
    pub fn set_standby(&self, pid: Option<u32>) {
        if let Some(Ok(mut h)) = self.shared.as_ref().map(|s| s.hosts.lock()) {
            h.standby = pid;
        }
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

    /// Tests only: see `Cmd::HoldNextPoll`. Returns once the reactor has taken the hold; the next
    /// command sent is then handled in a pass that also has child output to read.
    #[cfg(test)]
    pub(crate) fn hold_next_poll(&self) {
        let (tx, rx) = mpsc::channel();
        if self.send(Cmd::HoldNextPoll(tx)) {
            rx.recv_timeout(Duration::from_secs(15)).expect("the reactor took the hold");
        }
    }

    /// Resumes a frozen reactor (the handoff was rolled back).
    pub fn thaw(&self) {
        self.send(Cmd::Thaw);
    }

    /// Reaps, while frozen, every child that exited since the freeze (#280 step 4, at the commit).
    /// What the keeper holds, as the child socket's `list` answers it; None without a child service or
    /// when it does not answer within `wait`. For `keeper.sock`'s `children` (#538): the child socket
    /// itself answers only the hosts.
    pub fn list(&self, wait: Duration) -> Option<Vec<Value>> {
        let (tx, rx) = mpsc::channel();
        if !self.send(Cmd::List(tx)) {
            return None;
        }
        rx.recv_timeout(wait).ok()
    }

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
        let shared = Arc::new(Shared { cmds: Mutex::new(Vec::new()), wake: wake_w, sock: socket_path(data), hosts: Mutex::default() });
        let reactor = Reactor::restore(st, unpack, wake_r, shared.clone())?;
        Ok(Pending { reactor, shared })
    }

    /// Ends every child still running: stdin EOF for pipes and SIGHUP for ptys, then after `grace`
    /// TERM to each child's group, then KILL. A pty's signals go to every group in its session, so
    /// its shell's jobs end too (#840 item 2). Returns once they are gone (with what exited agents
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
    /// `host`: the host handed over with them, answered from the first accept (#538): the keeper
    /// names its host only once it is built, and a host's attach in between would have been refused.
    pub fn start(mut self, reaped: &[(i32, ExitStatus)], host: Option<u32>) -> io::Result<Children> {
        for &(pid, st) in reaped {
            self.reactor.watch.know(pid, st);
        }
        if let Ok(mut h) = self.shared.hosts.lock() {
            h.handed = host;
        }
        self.reactor.start()?;
        log(&format!("took over {} from the previous keeper", self.shared.sock.display()));
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

#[cfg(test)]
mod tests;
