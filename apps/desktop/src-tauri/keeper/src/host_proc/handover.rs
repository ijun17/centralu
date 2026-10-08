//! What only the keeper does with a host (#280 step 4): the stdout reader that can be frozen and
//! handed over, and supervising a host another keeper started. The keeper runs on unix only until
//! the OS layer has a Windows half (docs/plans/runtime-unification.md step 9); the process
//! mechanism itself is `crate::os`.

use std::io::Write;
use std::process::ChildStdout;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::{HostInfo, HostProc, Launcher, Lines, StatusSink, Supervisor};
use crate::os::pid_alive;

/// A host's stdout reader that can be paused for a keeper handoff.
pub type Gate = Arc<LineGate>;

/// A reader that can be paused for a keeper handoff (#280 step 4).
pub(super) fn host_lines(stdout: ChildStdout) -> (Lines, Option<Gate>) {
    let out = HostOut::new(stdout.into(), Vec::new());
    let gate = out.gate();
    (Box::new(out), Some(gate))
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
