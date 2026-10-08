//! The unix side of `host_proc`: process groups and signals, the stdout reader a keeper can freeze
//! and hand over (#280 step 4), and the login shell that knows where Node is. Everything here is
//! what `windows.rs` provides differently, plus what only the keeper does.

use std::io::{BufReader, Write};
use std::path::Path;
use std::process::{ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::{HostInfo, HostProc, Launcher, Lines, StatusSink, Supervisor};

/// A host's stdout reader that can be paused for a keeper handoff.
pub type Gate = Arc<LineGate>;

/// On unix stdin is kept open until the end, so EOF does not race the signal into a second
/// `shutdown()` (`stop_pid_gracefully`).
pub(super) const CLOSE_STDIN_TO_STOP: bool = false;

/// The group outlives its leader and its number is not reused while anyone is in it, so it is
/// signalled whether or not the host has ended (`stop_pid_gracefully`).
pub(super) const SIGNAL_GROUP_AFTER_EXIT: bool = true;

/// A group of its own, led by the host (`spawn_host`).
pub(super) fn own_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// A no-op off Windows.
pub fn hide_console(cmd: &mut Command) {
    let _ = cmd;
}

/// A reader that can be paused for a keeper handoff (#280 step 4).
pub(super) fn host_lines(stdout: ChildStdout) -> (Lines, Option<Gate>) {
    let out = HostOut::new(stdout.into(), Vec::new());
    let gate = out.gate();
    (Box::new(out), Some(gate))
}

/// `.bin/tsx`, a sh script, runs as it is.
pub(super) fn tsx_program(root: &str, _args: &mut Vec<String>) -> String {
    format!("{root}/node_modules/.bin/tsx")
}

impl Supervisor {
    /**
     * Stops reading the running host's stdout for a keeper handoff (#280 step 4) and returns what
     * the next keeper needs to go on supervising it. `Ok(None)` when no host is running (it gave
     * up): there is nothing to hand over. Refused while a host is starting, restarting, being
     * stopped or swapped: those are moments with a second process or a half-read ready line.
     */
    pub fn freeze(&self, wait: Duration) -> Result<Option<HostFreeze>, String> {
        let gate = {
            let inner = self.inner.lock().map_err(|_| "supervisor lock poisoned")?;
            if inner.shutting_down || inner.bouncing || inner.handing_over {
                return Err("the host is being stopped or swapped".into());
            }
            if !inner.running {
                return Ok(None);
            }
            match (&inner.child, &inner.gate, &inner.info) {
                (Some(_), Some(g), Some(_)) => g.clone(),
                _ => return Err("the host is starting or restarting".into()),
            }
        };
        let buffered = gate.freeze(wait)?;
        let frozen = (|| {
            let inner = self.inner.lock().map_err(|_| "supervisor lock poisoned".to_string())?;
            let child = inner.child.as_ref().ok_or("the host is gone")?;
            Ok::<_, String>(HostFreeze {
                pid: child.id(),
                stdin: child.dup_stdin().map_err(|e| e.to_string())?,
                stdout: gate.fd().try_clone_to_owned().map_err(|e| e.to_string())?,
                buffered,
                info: inner.info.clone(),
            })
        })();
        if frozen.is_err() {
            gate.thaw();
        }
        frozen.map(Some)
    }

    /// Resumes reading the host's stdout: the handoff was rolled back.
    pub fn thaw(&self) {
        if let Some(g) = self.inner.lock().ok().and_then(|i| i.gate.clone()) {
            g.thaw();
        }
    }

    /**
     * Takes over a host another keeper started and handed over (#280 step 4). From here it is
     * supervised like any other: its later lines reach the sink, and when it dies the next host is
     * started with `launcher` (as this supervisor's own child) by the usual rules.
     */
    pub fn adopt_foreign(&self, h: ForeignAdopt, sink: Arc<dyn StatusSink>, launcher: Launcher) -> Result<(), String> {
        if !self.claim(true) {
            return Err("the supervisor is already running a host".into());
        }
        let out = HostOut::new(h.stdout, h.buffered);
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_output.clear();
            inner.child = Some(HostProc::Foreign(Foreign { pid: h.pid, stdin: Some(std::fs::File::from(h.stdin)) }));
            inner.gate = Some(out.gate());
            inner.info = Some(h.info.clone());
        }
        self.watch(sink, launcher, Some((Box::new(out), h.info)));
        Ok(())
    }
}

impl HostProc {
    pub(super) fn dup_stdin(&self) -> std::io::Result<std::os::fd::OwnedFd> {
        use std::os::fd::AsFd;
        let missing = || std::io::Error::new(std::io::ErrorKind::NotConnected, "the host's stdin is closed");
        match self {
            HostProc::Own(c) => c.stdin.as_ref().ok_or_else(missing)?.as_fd().try_clone_to_owned(),
            HostProc::Foreign(f) => f.stdin.as_ref().ok_or_else(missing)?.as_fd().try_clone_to_owned(),
        }
    }
}

/// A host another keeper started and handed over (#280 step 4): this keeper holds its pipes but is
/// not its parent.
pub struct Foreign {
    pid: u32,
    stdin: Option<std::fs::File>,
}

impl Foreign {
    pub(super) fn id(&self) -> u32 {
        self.pid
    }

    pub(super) fn stdin(&mut self) -> Option<&mut dyn Write> {
        self.stdin.as_mut().map(|s| s as &mut dyn Write)
    }

    pub(super) fn take_stdin(&mut self) -> Option<Box<dyn Send>> {
        self.stdin.take().map(|s| Box::new(s) as Box<dyn Send>)
    }

    pub(super) fn has_exited(&mut self) -> bool {
        !pid_alive(self.pid)
    }

    /// SIGKILL, if it is still there.
    pub(super) fn kill(&mut self) {
        if pid_alive(self.pid) {
            // SAFETY: a plain syscall; the pid is the host we supervise and is still there.
            unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
        }
    }

    /// Waits for it to end. A foreign host is not ours to reap: its parent (init, once the keeper
    /// that started it has gone) does, and its exit code is not ours to read.
    pub(super) fn wait(&mut self) -> Option<i32> {
        let end = Instant::now() + Duration::from_secs(10);
        while pid_alive(self.pid) && Instant::now() < end {
            thread::sleep(Duration::from_millis(50));
        }
        None
    }
}

/**
 * A host's stdout, one line at a time, that can be **stopped between two lines** and handed to
 * another keeper (#280 step 4) with every byte it had read but not yet delivered.
 *
 * A `BufReader` would read ahead into a buffer nobody else can see, and a thread blocked in
 * `read` cannot be told to stop. So the bytes live in a buffer shared with whoever freezes it, and
 * the reading thread polls with a short timeout and parks when asked. The next keeper starts its
 * own reader with those bytes first: no status line is lost or seen twice.
 */
pub struct LineGate {
    st: Mutex<GateState>,
    cv: std::sync::Condvar,
    fd: std::os::fd::OwnedFd,
}

#[derive(Default)]
struct GateState {
    /// Read from the host and not yet returned as a line.
    buf: Vec<u8>,
    frozen: bool,
    parked: bool,
    eof: bool,
}

impl LineGate {
    /// Stops the reader at its next line boundary and returns the bytes it holds. Refused if the
    /// reader does not come back within `wait` (it is inside the sink, which should not happen).
    pub fn freeze(&self, wait: Duration) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + wait;
        let mut st = self.st.lock().map_err(|_| "host reader poisoned")?;
        st.frozen = true;
        while !st.parked {
            if st.eof {
                st.frozen = false;
                return Err("the host has exited".into());
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                st.frozen = false;
                self.cv.notify_all();
                return Err("the host's output reader did not pause in time".into());
            };
            st = self.cv.wait_timeout(st, left).map_err(|_| "host reader poisoned")?.0;
        }
        Ok(st.buf.clone())
    }

    pub fn thaw(&self) {
        if let Ok(mut st) = self.st.lock() {
            st.frozen = false;
        }
        self.cv.notify_all();
    }

    pub fn fd(&self) -> std::os::fd::BorrowedFd<'_> {
        use std::os::fd::AsFd;
        self.fd.as_fd()
    }
}

/// What `HostOut::next_line` found.
#[derive(Debug, PartialEq)]
pub enum NextLine {
    Line(String),
    Timeout,
    End,
}

pub struct HostOut(Arc<LineGate>);

impl HostOut {
    /// A reader over the host's stdout. `initial` is what a previous keeper had read and not yet
    /// delivered.
    pub fn new(fd: std::os::fd::OwnedFd, initial: Vec<u8>) -> HostOut {
        HostOut(Arc::new(LineGate {
            st: Mutex::new(GateState { buf: initial, ..Default::default() }),
            cv: std::sync::Condvar::new(),
            fd,
        }))
    }

    pub fn gate(&self) -> Arc<LineGate> {
        self.0.clone()
    }

    /// The next line, waiting until `deadline` (forever with None).
    pub fn next_line(&self, deadline: Option<Instant>) -> NextLine {
        use std::os::fd::AsRawFd;
        let g = &self.0;
        loop {
            {
                let Ok(mut st) = g.st.lock() else { return NextLine::End };
                if st.frozen {
                    st.parked = true;
                    g.cv.notify_all();
                    while st.frozen {
                        st = match g.cv.wait(st) {
                            Ok(s) => s,
                            Err(_) => return NextLine::End,
                        };
                    }
                    st.parked = false;
                }
                if let Some(i) = st.buf.iter().position(|&b| b == b'\n') {
                    let mut line: Vec<u8> = st.buf.drain(..=i).collect();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    return NextLine::Line(String::from_utf8_lossy(&line).into_owned());
                }
                if st.eof {
                    if st.buf.is_empty() {
                        return NextLine::End;
                    }
                    let rest = std::mem::take(&mut st.buf);
                    return NextLine::Line(String::from_utf8_lossy(&rest).into_owned());
                }
            }
            let mut wait_ms = 100;
            if let Some(d) = deadline {
                let Some(left) = d.checked_duration_since(Instant::now()) else { return NextLine::Timeout };
                wait_ms = wait_ms.min(left.as_millis() as i32 + 1);
            }
            let mut p = libc::pollfd { fd: g.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            if unsafe { libc::poll(&mut p, 1, wait_ms) } <= 0 {
                continue;
            }
            let mut tmp = [0u8; 16 * 1024];
            // SAFETY: tmp is valid for its length.
            let n = unsafe { libc::read(g.fd.as_raw_fd(), tmp.as_mut_ptr() as *mut libc::c_void, tmp.len()) };
            let Ok(mut st) = g.st.lock() else { return NextLine::End };
            if n > 0 {
                st.buf.extend_from_slice(&tmp[..n as usize]);
            } else if n == 0 {
                st.eof = true;
            } else {
                let e = std::io::Error::last_os_error();
                if !matches!(e.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock) {
                    st.eof = true;
                }
            }
        }
    }
}

impl Iterator for HostOut {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        match self.next_line(None) {
            NextLine::Line(l) => Some(l),
            _ => None,
        }
    }
}

/// A running host frozen for a keeper handoff (#280 step 4): what the next keeper needs to go on
/// supervising it.
pub struct HostFreeze {
    pub pid: u32,
    pub stdin: std::os::fd::OwnedFd,
    pub stdout: std::os::fd::OwnedFd,
    /// Read from its stdout and not yet delivered.
    pub buffered: Vec<u8>,
    pub info: Option<HostInfo>,
}

/// A host another keeper started, handed over at a commit (#280 step 4).
pub struct ForeignAdopt {
    pub pid: u32,
    pub stdin: std::os::fd::OwnedFd,
    pub stdout: std::os::fd::OwnedFd,
    pub buffered: Vec<u8>,
    pub info: HostInfo,
}

/// Whether a process exists and is not a zombie waiting for someone else to reap it.
pub(super) fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// SIGTERM to the single host process only — children (codex, etc.) are cleaned up by the
/// host itself via EOF (#57).
pub fn kill_pid(pid: u32) {
    if let Some(pid) = signal_target(pid) {
        // SAFETY: a plain syscall to one positive pid.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
}

/**
 * The pid or process group number a signal may be sent to, or None for the numbers that mean
 * something else to `kill(2)`: 0 (the caller's own group), 1 (as a group, `-1` is every process
 * the user may signal) and anything that does not fit a positive `pid_t` (it would turn negative).
 */
pub(super) fn signal_target(pid: u32) -> Option<i32> {
    i32::try_from(pid).ok().filter(|&p| p > 1)
}

/**
 * SIGTERM to the process group `pid` leads (`spawn_host` made the group number the host's pid),
 * never to the caller's own group.
 *
 * `kill(2)` with the number negated, not `/bin/kill -TERM -<pid>` as before (#350). procps-ng
 * 4.0.4's `kill` (Ubuntu 24.04) reads a `-<pid>` that follows a signal option as more options and
 * signals the group named by **its first digit**: `-12345` became `kill(-1, SIGTERM)`, every
 * process the user may signal, and `-40000` became group 4. macOS's `kill` reads it as a group,
 * which is why only Linux ever saw it (docs/spikes/2026-10-linux-keeper.md).
 */
pub fn kill_group(pid: u32) {
    let Some(pgid) = signal_target(pid) else { return };
    // SAFETY: getpgrp takes no arguments.
    if pgid == unsafe { libc::getpgrp() } {
        return;
    }
    // SAFETY: a plain syscall; a negative pid is the group, and `signal_target` ruled out 0 and 1.
    unsafe { libc::kill(-pgid, libc::SIGTERM) };
}

/// Told to someone who has no Node at all, so it has to name a command they can actually
/// run. `brew` was hardcoded, which on Linux points at a package manager that is not
/// there — the one message whose whole job is to unblock a stuck user would have sent
/// them somewhere else.
#[cfg(target_os = "macos")]
pub(super) const INSTALL_NODE_HINT: &str = "`brew install node`";
#[cfg(not(target_os = "macos"))]
pub(super) const INSTALL_NODE_HINT: &str = "your distribution's package manager (for example, `apt install nodejs`)";

#[cfg(target_os = "macos")]
pub(super) const UPGRADE_NODE_HINT: &str = "`brew upgrade node`";
#[cfg(not(target_os = "macos"))]
pub(super) const UPGRADE_NODE_HINT: &str = "your distribution's package manager";

/// The first place `pick_node` asks, named in the "looked in" list.
pub(super) const FIRST_LOOK: &str = "login shell PATH";

pub(super) fn probe_first() -> Option<String> {
    probe_login_shell()
}

/// Asks the login shell where node is. It has to be interactive (-i) for .zshrc's nvm/mise
/// initialization to run.
///
/// Only the line carrying the marker is picked out, so it does not matter what else the shell
/// configuration prints.
pub(super) fn probe_login_shell() -> Option<String> {
    use std::io::Read;

    let shell = std::env::var("SHELL").ok()?;
    if !Path::new(&shell).exists() {
        return None;
    }

    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", "command -p echo \"__CC_NODE__:$(command -v node)\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // So the shell's initialization script does not put up an interactive prompt.
        .env("TERM", "dumb")
        .env("CI", "1");
    // A session of its own, not only a group: its group is still its pid, which `kill_group`
    // below needs, and it has no controlling terminal. An interactive shell in a background group
    // of a terminal's session is stopped (SIGTTOU) when it sets up job control, so an app started
    // from a terminal (the npm launcher runs the AppImage attached to one) waited out the 5 s
    // below and fell back to the fixed paths. Measured in WSL2 Ubuntu 24.04: state `T` in a group
    // of its own, the answer in 0.04 s in a session of its own (docs/spikes/2026-10-linux-keeper.md).
    crate::keeper::sys::new_session(&mut cmd);

    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let stdout = child.stdout.take()?;

    // **Getting stuck here would fail the whole app's launch.** Shell configurations really do
    // sometimes wait forever (waiting on prompt input, for example), so this cuts it off on a
    // timer and kills the whole group.
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stdout).read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let out = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(out) => out,
        Err(_) => {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();

    super::node::parse_probe_output(&out)
}

/// The fallback for when the shell cannot be used. Checks not just Homebrew but the common
/// locations of version managers too.
pub(super) fn fallback_node_paths() -> Vec<String> {
    super::node::node_paths_under(&std::env::var("HOME").unwrap_or_default())
}
