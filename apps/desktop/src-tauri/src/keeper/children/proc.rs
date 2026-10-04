//! Starting, signalling and watching the children the keeper holds — the system calls `std` does
//! not offer.
//!
//! Every child starts in a session of its own (`setsid`), so it is in neither the keeper's nor any
//! host's process group: a host's group kill, a host's exit, or a terminal's Ctrl-C reaching the
//! app cannot reach it. Only an explicit request does.

use std::collections::HashMap;
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

/// A started child. For a pty, `out` is the master and carries both directions.
pub struct Spawned {
    pub pid: i32,
    pub stdin: Option<OwnedFd>,
    pub out: OwnedFd,
    pub err: Option<OwnedFd>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ExitStatus {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl ExitStatus {
    pub fn from_wait_status(status: i32) -> Self {
        if libc::WIFEXITED(status) {
            ExitStatus { code: Some(libc::WEXITSTATUS(status)), signal: None }
        } else if libc::WIFSIGNALED(status) {
            ExitStatus { code: None, signal: Some(libc::WTERMSIG(status)) }
        } else {
            ExitStatus { code: None, signal: None }
        }
    }
}

fn command(cmd: &str, args: &[String], cwd: &str, env: &HashMap<String, String>) -> Command {
    let mut c = Command::new(cmd);
    c.args(args).current_dir(cwd).env_clear().envs(env);
    c
}

/// claude and codex app-server: three pipes, a session of their own.
pub fn spawn_pipes(cmd: &str, args: &[String], cwd: &str, env: &HashMap<String, String>) -> io::Result<Spawned> {
    let mut c = command(cmd, args, cwd, env);
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // SAFETY: setsid is async-signal-safe, which is all pre_exec requires.
    unsafe {
        c.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = c.spawn()?;
    let pid = child.id() as i32;
    let stdin: OwnedFd = child.stdin.take().ok_or_else(|| io::Error::other("no stdin pipe"))?.into();
    let out: OwnedFd = child.stdout.take().ok_or_else(|| io::Error::other("no stdout pipe"))?.into();
    let err: OwnedFd = child.stderr.take().ok_or_else(|| io::Error::other("no stderr pipe"))?.into();
    // `child` is dropped without waiting: the exit watch reaps it.
    for fd in [&stdin, &out, &err] {
        set_nonblocking(fd.as_raw_fd())?;
    }
    Ok(Spawned { pid, stdin: Some(stdin), out, err: Some(err) })
}

/**
 * A terminal or a project command: the keeper owns the pty, so the master — and with it the
 * screen and the child's life — does not live in a host that may be replaced (#280 item 4).
 *
 * `openpty`, then in the child `setsid` and `TIOCSCTTY` on the slave, the same three steps
 * node-pty takes and the #280 measurement used.
 */
pub fn spawn_pty(
    cmd: &str,
    args: &[String],
    cwd: &str,
    env: &HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> io::Result<Spawned> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut ws = winsize(cols, rows);
    // SAFETY: valid out-pointers; name and termios are optional and passed as null.
    let rc = unsafe {
        libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws as *mut libc::winsize as _)
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty just returned these two descriptors to us.
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    // openpty does not set close-on-exec; without it every later child would inherit both ends.
    set_cloexec(master.as_raw_fd())?;
    set_cloexec(slave.as_raw_fd())?;
    let mut c = command(cmd, args, cwd, env);
    c.stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave.try_clone()?));
    // SAFETY: setsid and ioctl are async-signal-safe.
    unsafe {
        c.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            // stdin is the slave by now: make it this new session's controlling terminal.
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = c.spawn()?;
    let pid = child.id() as i32;
    drop(c);
    drop(slave);
    set_nonblocking(master.as_raw_fd())?;
    Ok(Spawned { pid, stdin: None, out: master, err: None })
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(2), ws_col: cols.max(2), ws_xpixel: 0, ws_ypixel: 0 }
}

pub fn resize(master: RawFd, cols: u16, rows: u16) -> io::Result<()> {
    let ws = winsize(cols, rows);
    // SAFETY: TIOCSWINSZ reads one winsize from a valid pointer.
    if unsafe { libc::ioctl(master, libc::TIOCSWINSZ as _, &ws) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags == -1 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags == -1 || libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn read_fd(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    // SAFETY: buf is valid for buf.len() bytes.
    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}

pub fn write_fd(fd: RawFd, buf: &[u8]) -> io::Result<usize> {
    // SAFETY: buf is valid for buf.len() bytes.
    let n = unsafe { libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len()) };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}

/// The signals a host may ask for, by name (`SIGTERM` or `TERM`).
pub fn signal_number(name: &str) -> Option<i32> {
    let n = name.trim().trim_start_matches("SIG");
    Some(match n {
        "TERM" => libc::SIGTERM,
        "KILL" => libc::SIGKILL,
        "INT" => libc::SIGINT,
        "HUP" => libc::SIGHUP,
        "QUIT" => libc::SIGQUIT,
        "USR1" => libc::SIGUSR1,
        "USR2" => libc::SIGUSR2,
        "WINCH" => libc::SIGWINCH,
        _ => return None,
    })
}

/// Signals the child, or its whole process group (which `setsid` made the same number).
pub fn signal(pid: i32, sig: i32, group: bool) -> io::Result<()> {
    if pid <= 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to signal pid <= 1"));
    }
    let target = if group { -pid } else { pid };
    // SAFETY: a plain syscall.
    if unsafe { libc::kill(target, sig) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub enum Reap {
    Reaped(ExitStatus),
    /// Ours, not exited yet (or exited a moment ago and not yet waitable).
    Running,
    /// Not our child: someone else reaps it.
    NotOurs,
}

/// Reaps `pid` if it is our child and has exited.
pub fn reap(pid: i32) -> Reap {
    let mut status: libc::c_int = 0;
    // SAFETY: a valid out-pointer.
    let rc = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if rc == pid {
        Reap::Reaped(ExitStatus::from_wait_status(status))
    } else if rc == 0 {
        Reap::Running
    } else {
        Reap::NotOurs
    }
}

pub fn try_reap(pid: i32) -> Option<ExitStatus> {
    match reap(pid) {
        Reap::Reaped(st) => Some(st),
        _ => None,
    }
}

/// Whether a process with this pid exists (whoever owns it).
pub fn exists(pid: i32) -> bool {
    // SAFETY: signal 0 only checks.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/**
 * Learns that a child exited, and how.
 *
 * - **macOS: kqueue `EVFILT_PROC` with `NOTE_EXIT | NOTE_EXITSTATUS`.** It works for a process
 *   that is not our child and still returns the exit status (measured in #280: status `7 << 8` for
 *   `exit 7` seen by a non-parent). In step 2 the keeper is every child's parent, but a keeper that
 *   takes its children over from another keeper (step 4) will not be, so the watch is the one that
 *   keeps working then. `waitpid` still reaps what is ours.
 * - **Linux: a `pidfd` per child**, readable once the child exits, then `waitpid` (the keeper is
 *   the parent in step 2). Kernels without `pidfd_open` fall back to polling `waitpid`.
 * - Elsewhere: polling `waitpid`.
 *
 * The watch's descriptors join the reactor's `poll`; `collect` is called when one is readable and
 * on every tick.
 */
pub struct ExitWatch {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    kq: OwnedFd,
    #[cfg(target_os = "linux")]
    pidfds: HashMap<i32, OwnedFd>,
    /// Children watched by polling `waitpid` (no kqueue registration, no pidfd).
    polled: Vec<i32>,
    /// Exits learned while registering (the child was already gone).
    ready: Vec<(i32, ExitStatus)>,
    /// Children whose exit was reported before `waitpid` could collect them: reaped on a later
    /// pass, so no zombie is left behind.
    unreaped: Vec<i32>,
}

impl ExitWatch {
    pub fn new() -> io::Result<Self> {
        Ok(ExitWatch {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kq: {
                // SAFETY: kqueue takes no arguments.
                let fd = unsafe { libc::kqueue() };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                set_cloexec(fd)?;
                // SAFETY: kqueue just returned it.
                unsafe { OwnedFd::from_raw_fd(fd) }
            },
            #[cfg(target_os = "linux")]
            pidfds: HashMap::new(),
            polled: Vec::new(),
            ready: Vec::new(),
            unreaped: Vec::new(),
        })
    }

    pub fn watch(&mut self, pid: i32) {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            let ev = libc::kevent {
                ident: pid as libc::uintptr_t,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT | libc::NOTE_EXITSTATUS,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            // SAFETY: one valid changelist entry, no event list.
            let rc = unsafe { libc::kevent(self.kq.as_raw_fd(), &ev, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
            if rc == 0 {
                return;
            }
            // ESRCH: it is already gone. Reap it now, or poll for it if it is not ours.
            match try_reap(pid) {
                Some(st) => self.ready.push((pid, st)),
                None => self.polled.push(pid),
            }
        }
        #[cfg(target_os = "linux")]
        {
            // SAFETY: pidfd_open(pid, 0) takes no pointers.
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
            if fd >= 0 {
                let _ = set_cloexec(fd);
                // SAFETY: the syscall just returned it.
                self.pidfds.insert(pid, unsafe { OwnedFd::from_raw_fd(fd) });
            } else {
                self.polled.push(pid);
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux")))]
        self.polled.push(pid);
    }

    /// Descriptors to poll for readability.
    pub fn fds(&self) -> Vec<RawFd> {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        return vec![self.kq.as_raw_fd()];
        #[cfg(target_os = "linux")]
        return self.pidfds.values().map(|f| f.as_raw_fd()).collect();
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux")))]
        return Vec::new();
    }

    /// Whether some child can only be found by polling (the reactor then ticks faster).
    pub fn polling(&self) -> bool {
        !self.polled.is_empty() || !self.unreaped.is_empty()
    }

    /// Exits since the last call.
    pub fn collect(&mut self) -> Vec<(i32, ExitStatus)> {
        let mut out = std::mem::take(&mut self.ready);
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        loop {
            let mut evs: [libc::kevent; 32] = unsafe { std::mem::zeroed() };
            let zero = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            // SAFETY: an event list of 32 valid entries, a zero timeout.
            let n = unsafe { libc::kevent(self.kq.as_raw_fd(), std::ptr::null(), 0, evs.as_mut_ptr(), 32, &zero) };
            if n <= 0 {
                break;
            }
            for ev in &evs[..n as usize] {
                if ev.filter != libc::EVFILT_PROC || ev.fflags & libc::NOTE_EXIT == 0 {
                    continue;
                }
                let pid = ev.ident as i32;
                // Ours: reap it (and take waitpid's word for the status). Not ours: the status
                // came with the event. NOTE_EXIT can fire a moment before the zombie is waitable;
                // such a child is reaped on a later pass.
                let st = match reap(pid) {
                    Reap::Reaped(st) => st,
                    Reap::Running => {
                        self.unreaped.push(pid);
                        ExitStatus::from_wait_status(ev.data as i32)
                    }
                    Reap::NotOurs => ExitStatus::from_wait_status(ev.data as i32),
                };
                out.push((pid, st));
            }
        }
        #[cfg(target_os = "linux")]
        {
            let pids: Vec<i32> = self.pidfds.keys().copied().collect();
            for pid in pids {
                if let Some(st) = try_reap(pid) {
                    self.pidfds.remove(&pid);
                    out.push((pid, st));
                }
            }
        }
        self.unreaped.retain(|&pid| reap(pid) == Reap::Running);
        let polled = std::mem::take(&mut self.polled);
        for pid in polled {
            match try_reap(pid) {
                Some(st) => out.push((pid, st)),
                None if !exists(pid) => out.push((pid, ExitStatus { code: None, signal: None })),
                None => self.polled.push(pid),
            }
        }
        out
    }
}

/// Looks a program up the way a shell would, on the PATH the host passed for the child. `Command`
/// itself searches the keeper's own PATH, which under launchd is the bare default.
pub fn resolve_program(cmd: &str, env: &HashMap<String, String>) -> String {
    if cmd.contains('/') {
        return cmd.to_string();
    }
    if let Some(path) = env.get("PATH") {
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            let candidate = std::path::Path::new(dir).join(cmd);
            if let Ok(c) = CString::new(candidate.to_string_lossy().as_bytes()) {
                // SAFETY: a valid C string.
                if unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0 {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }
    cmd.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn env() -> HashMap<String, String> {
        let mut e = HashMap::new();
        e.insert("PATH".into(), "/usr/bin:/bin".into());
        e
    }

    fn wait_exit(w: &mut ExitWatch, pid: i32) -> ExitStatus {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            for (p, st) in w.collect() {
                if p == pid {
                    return st;
                }
            }
            assert!(Instant::now() < end, "no exit seen for {pid}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_child_runs_in_a_session_of_its_own_and_its_exit_status_is_seen() {
        let mut w = ExitWatch::new().unwrap();
        let s = spawn_pipes("/bin/sh", &["-c".into(), "exit 7".into()], "/", &env()).unwrap();
        w.watch(s.pid);
        assert_eq!(wait_exit(&mut w, s.pid), ExitStatus { code: Some(7), signal: None });
    }

    #[test]
    fn a_signalled_child_reports_the_signal() {
        let mut w = ExitWatch::new().unwrap();
        let s = spawn_pipes("/bin/sleep", &["30".into()], "/", &env()).unwrap();
        w.watch(s.pid);
        // SAFETY: getsid on a pid we just started.
        let sid = unsafe { libc::getsid(s.pid) };
        assert_eq!(sid, s.pid, "setsid made the child its own session leader");
        signal(s.pid, libc::SIGTERM, true).unwrap();
        assert_eq!(wait_exit(&mut w, s.pid).signal, Some(libc::SIGTERM));
    }

    #[test]
    fn a_pty_child_sees_a_terminal_of_the_asked_size_and_follows_a_resize() {
        let mut w = ExitWatch::new().unwrap();
        let s = spawn_pty("/bin/sh", &["-c".into(), "stty size; read x; stty size".into()], "/", &env(), 80, 24).unwrap();
        w.watch(s.pid);
        let fd = s.out.as_raw_fd();
        let mut got = Vec::new();
        let read_until = |got: &mut Vec<u8>, needle: &str| {
            let end = Instant::now() + Duration::from_secs(5);
            while !String::from_utf8_lossy(got).contains(needle) {
                assert!(Instant::now() < end, "never saw {needle:?} in {:?}", String::from_utf8_lossy(got));
                let mut b = [0u8; 1024];
                match read_fd(fd, &mut b) {
                    Ok(n) if n > 0 => got.extend_from_slice(&b[..n]),
                    _ => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        };
        read_until(&mut got, "24 80");
        resize(fd, 132, 50).unwrap();
        write_fd(fd, b"\n").unwrap();
        read_until(&mut got, "50 132");
        wait_exit(&mut w, s.pid);
    }

    #[test]
    fn programs_are_found_on_the_path_given_for_the_child() {
        let found = resolve_program("sh", &env());
        assert!(found == "/usr/bin/sh" || found == "/bin/sh", "{found}");
        assert_eq!(resolve_program("/bin/sh", &HashMap::new()), "/bin/sh");
        assert_eq!(resolve_program("no-such-program-cc", &env()), "no-such-program-cc");
    }

    #[test]
    fn only_known_signal_names_are_accepted() {
        assert_eq!(signal_number("SIGTERM"), Some(libc::SIGTERM));
        assert_eq!(signal_number("KILL"), Some(libc::SIGKILL));
        assert_eq!(signal_number("SIGSTOP"), None);
        assert!(signal(1, libc::SIGTERM, false).is_err(), "never pid 1");
    }
}
