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

use crate::os::this_unix::ExitBackend;

/// A started child. For a pty, `out` is the master and carries both directions.
pub struct Spawned {
    pub pid: i32,
    pub stdin: Option<OwnedFd>,
    pub out: OwnedFd,
    pub err: Option<OwnedFd>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

/**
 * Signals what is left of an exited child's process group: helpers an agent CLI started (a language
 * server, an MCP server, a shell) that it did not stop before it ended. Returns whether anything was
 * signalled.
 *
 * Only ever the child's own group. `setsid` made the group number the child's pid, and a group
 * number is not reused while anyone is still in the group (POSIX), so as long as nobody holds that
 * number as a pid, a group by that number can only be what the child left behind. Anyone holding
 * it means the child is not reaped yet (its own zombie, or one another parent has not reaped) or
 * the number has been given to someone else: either way nothing is sent, and a later sweep tries
 * again. The keeper's own group is never a target (#350).
 */
pub fn signal_leftovers(pgid: i32, sig: i32) -> bool {
    // SAFETY: getpgrp takes no arguments.
    if pgid <= 1 || exists(pgid) || pgid == unsafe { libc::getpgrp() } {
        return false;
    }
    // SAFETY: a plain syscall; a negative pid is the group.
    unsafe { libc::kill(-pgid, sig) == 0 }
}

/// Whether any process is still in the group.
pub fn group_exists(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    // SAFETY: signal 0 only checks.
    let rc = unsafe { libc::kill(-pgid, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
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
 * What the OS offers differs (`ExitBackend` in `macos.rs` and `linux.rs`):
 *
 * - **macOS: kqueue `EVFILT_PROC` with `NOTE_EXIT | NOTE_EXITSTATUS`.** It works for a process
 *   that is not our child and still returns the exit status (measured in #280: status `7 << 8` for
 *   `exit 7` seen by a non-parent). A keeper that took its children over from another keeper
 *   (step 4) is not their parent, so this is the watch that keeps working then. `waitpid` still
 *   reaps what is ours. **Registering on a zombie fails with `ESRCH`** (measured 2026-10-04 on
 *   Darwin 27: `EV_ERROR`, data 3, for a non-child that had exited but was not reaped), so a child
 *   that exited in the moment between the outgoing keeper freezing and this one registering is
 *   polled instead, and its status comes from the outgoing keeper, which reaps it (`know`).
 * - **Linux: a `pidfd` per child**, readable once the child exits. Ours: `waitpid` reaps it and
 *   gives the status. Not ours (taken over in step 4): the parent was the outgoing keeper, and once
 *   that exits init (or the nearest subreaper) reaps the child, so `waitpid` cannot; the status is
 *   read from `/proc/<pid>/stat` while the zombie is still there, else it is unknown. Linux has no
 *   non-parent exit status before `PIDFD_GET_INFO` (6.15). Kernels without `pidfd_open` fall back
 *   to polling.
 * - Elsewhere: polling `waitpid`.
 *
 * The watch's descriptors join the reactor's `poll`; `collect` is called when one is readable and
 * on every tick.
 */
pub struct ExitWatch {
    backend: ExitBackend,
    /// Children watched by polling `waitpid` (no kqueue registration, no pidfd).
    polled: Vec<i32>,
    /// Exits learned while registering (the child was already gone).
    ready: Vec<(i32, ExitStatus)>,
    /// Children whose exit was reported before `waitpid` could collect them: reaped on a later
    /// pass, so no zombie is left behind.
    unreaped: Vec<i32>,
    /// Exit statuses learned some other way: the outgoing keeper reaped these children as it
    /// handed over (step 4). Used when this watch can only tell that a child is gone.
    known: HashMap<i32, ExitStatus>,
}

/// What an `ExitBackend` made of a child it was asked to watch.
pub enum Watch {
    /// The OS will say when it exits.
    Registered,
    /// It is already gone (kqueue refuses a zombie): reap it now, or poll for it if it is not ours.
    Gone,
    /// The OS cannot watch it: poll.
    Poll,
}

/// A child the backend has news of, or may have.
pub struct Seen {
    pub pid: i32,
    /// The OS reported the exit with its status (kqueue). `None`: the backend only knows the child
    /// may have changed (a pidfd), and `ExitBackend::gone` says whether it ended.
    pub exited: Option<ExitStatus>,
}

impl ExitWatch {
    pub fn new() -> io::Result<Self> {
        Ok(ExitWatch {
            backend: ExitBackend::new()?,
            polled: Vec::new(),
            ready: Vec::new(),
            unreaped: Vec::new(),
            known: HashMap::new(),
        })
    }

    /// An exit status reported by the outgoing keeper, which was this child's parent and reaped
    /// it (#280 step 4). Used once the watch sees the child gone and cannot learn the status
    /// itself.
    pub fn know(&mut self, pid: i32, st: ExitStatus) {
        self.known.insert(pid, st);
    }

    fn unknown_status(&mut self, pid: i32) -> ExitStatus {
        self.known.remove(&pid).unwrap_or(ExitStatus { code: None, signal: None })
    }

    pub fn watch(&mut self, pid: i32) {
        match self.backend.watch(pid) {
            Watch::Registered => {}
            Watch::Gone => match try_reap(pid) {
                Some(st) => self.ready.push((pid, st)),
                None => self.polled.push(pid),
            },
            Watch::Poll => self.polled.push(pid),
        }
    }

    /// Descriptors to poll for readability.
    pub fn fds(&self) -> Vec<RawFd> {
        self.backend.fds()
    }

    /// Whether some child can only be found by polling (the reactor then ticks faster).
    pub fn polling(&self) -> bool {
        !self.polled.is_empty() || !self.unreaped.is_empty()
    }

    /// Exits since the last call.
    pub fn collect(&mut self) -> Vec<(i32, ExitStatus)> {
        let mut out = std::mem::take(&mut self.ready);
        for Seen { pid, exited } in self.backend.seen() {
            // Ours: reap it (and take waitpid's word for the status). Not ours: the status came
            // with the event, or from the outgoing keeper, or from the zombie. An exit event can
            // fire a moment before the zombie is waitable; such a child is reaped on a later pass.
            match (reap(pid), exited) {
                (Reap::Reaped(st), _) => {
                    self.backend.forget(pid);
                    out.push((pid, st));
                }
                (Reap::Running, Some(st)) => {
                    self.unreaped.push(pid);
                    out.push((pid, st));
                }
                (Reap::Running, None) => {}
                (Reap::NotOurs, Some(st)) => out.push((pid, st)),
                // Taken over from another keeper: the backend says it has gone; init reaps it.
                // Without this a readable pidfd would wake every poll forever.
                (Reap::NotOurs, None) => {
                    if self.backend.gone(pid) {
                        self.backend.forget(pid);
                        let st = match self.known.remove(&pid) {
                            Some(st) => st,
                            None => ExitBackend::zombie_status(pid).unwrap_or(ExitStatus { code: None, signal: None }),
                        };
                        out.push((pid, st));
                    }
                }
            }
        }
        self.unreaped.retain(|&pid| reap(pid) == Reap::Running);
        let polled = std::mem::take(&mut self.polled);
        for pid in polled {
            match try_reap(pid) {
                Some(st) => out.push((pid, st)),
                None if !exists(pid) => {
                    let st = self.unknown_status(pid);
                    out.push((pid, st))
                }
                None => self.polled.push(pid),
            }
        }
        out
    }
}

/// A zombie's exit status from the text of `/proc/<pid>/stat` (field 52, `exit_code`, the raw wait
/// status; Linux 3.5+). Only a process in state `Z` qualifies: anything else under that pid is not
/// the child that exited. The command name (field 2) may hold spaces and parentheses, so fields are
/// counted from the last `)`. Plain parsing, so it is tested on every OS; Linux reads the file.
pub fn parse_proc_exit(stat: &str) -> Option<ExitStatus> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // fields[0] is field 3 (state); field 52 is fields[49].
    if fields.first() != Some(&"Z") {
        return None;
    }
    let raw: i32 = fields.get(49)?.parse().ok()?;
    Some(ExitStatus::from_wait_status(raw))
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

    /// After a keeper handoff the keeper is not its children's parent. The watch must still see
    /// such a child exit (macOS: kqueue, with its status; Linux: pidfd, status from /proc while the
    /// zombie lasts), and must not spin on it.
    #[test]
    fn the_exit_of_a_process_that_is_not_our_child_is_seen() {
        // The shell starts a sleeper and exits at once: the sleeper is reparented away from us.
        let out = Command::new("/bin/sh").args(["-c", "sleep 1 >/dev/null 2>&1 & echo $!"]).output().unwrap();
        let pid: i32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let mut w = ExitWatch::new().unwrap();
        w.watch(pid);
        assert_eq!(reap(pid), Reap::NotOurs, "not our child");
        assert!(w.collect().is_empty(), "still running");
        let st = wait_exit(&mut w, pid);
        if cfg!(target_os = "macos") {
            assert_eq!(st, ExitStatus { code: Some(0), signal: None }, "kqueue reports a non-child's status");
        } else {
            assert!(st == ExitStatus { code: Some(0), signal: None } || st == ExitStatus { code: None, signal: None }, "{st:?}");
        }
        assert!(w.collect().is_empty() && !w.polling(), "reported once, and nothing left to watch");
    }

    #[test]
    fn a_zombie_exit_status_is_read_from_proc_stat() {
        // `exit 7` is wait status 7 << 8 = 1792; a name with spaces and a ')' does not shift fields.
        let mut f: Vec<String> = vec!["Z".into()];
        f.extend((4..=51).map(|i| i.to_string()));
        f.push("1792".into());
        let zombie = format!("42 (we ird) name) {}", f.join(" "));
        assert_eq!(parse_proc_exit(&zombie), Some(ExitStatus { code: Some(7), signal: None }));
        assert_eq!(parse_proc_exit(&zombie.replacen(") Z ", ") S ", 1)), None, "only a zombie is the exited child");
    }

    /// The handoff (#280 step 4): a child registered after it had already exited, by a watch that
    /// is not its parent, is reported with the status the outgoing keeper reaped.
    #[test]
    fn a_status_from_the_outgoing_keeper_completes_a_polled_child() {
        let mut w = ExitWatch::new().unwrap();
        w.polled.push(999_999);
        w.know(999_999, ExitStatus { code: Some(3), signal: None });
        assert_eq!(w.collect(), vec![(999_999, ExitStatus { code: Some(3), signal: None })]);
    }

    #[test]
    fn only_known_signal_names_are_accepted() {
        assert_eq!(signal_number("SIGTERM"), Some(libc::SIGTERM));
        assert_eq!(signal_number("KILL"), Some(libc::SIGKILL));
        assert_eq!(signal_number("SIGSTOP"), None);
        assert!(signal(1, libc::SIGTERM, false).is_err(), "never pid 1");
    }
}
