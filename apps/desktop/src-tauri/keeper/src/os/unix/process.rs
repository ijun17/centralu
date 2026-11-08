//! One process watched by its identity rather than its number: a handed-over host (#840 item 8). What is left of the
//! exit watch the children service had (#1895 step 4, PR 2); it goes with the keeper handoff (PR 6). The OS half,
//! `ExitBackend`, is in `macos.rs` (kqueue) and `linux.rs` (a pidfd).

use std::io;
use std::os::fd::RawFd;

use crate::os::this_unix::ExitBackend;

/// What an `ExitBackend` made of a process it was asked to watch.
pub enum Watch {
    /// The OS will say when it exits.
    Registered,
    /// It is already gone (kqueue refuses a zombie).
    Gone,
    /// The OS cannot watch it: poll.
    Poll,
}

impl Watch {
    /**
     * What a registration that failed with `e` means (#840 item 8, review): `ESRCH`, no process by
     * that number, is the one answer that says it has gone (kqueue refuses a zombie this way too).
     * Anything else (a kernel without `pidfd_open`, out of descriptors) says nothing about the
     * process, which is then polled by its number. Read as "gone", such an error had a handed-over
     * host that still ran treated as ended.
     */
    pub fn after_error(e: io::Error) -> Watch {
        if e.raw_os_error() == Some(libc::ESRCH) {
            Watch::Gone
        } else {
            Watch::Poll
        }
    }
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

/**
 * One process watched by its identity rather than its number (#840 item 8): a kqueue registration on
 * macOS, a pidfd on Linux. A process another keeper started (a handed-over host) is not ours to reap,
 * so once it has ended and its parent has reaped it, its pid may be given to someone else, and
 * `kill(pid, 0)` would then find that someone: the host would read as running, and a stop would
 * signal a stranger. The watch is made while the process cannot have been reaped yet (the outgoing
 * keeper, its parent, reaps only after the commit), and once it reports the end that answer stays.
 * Where neither is available (a kernel before pidfds, another unix) it falls back to `pid_alive`.
 */
pub struct ProcessWatch {
    pid: i32,
    backend: ExitBackend,
    polled: bool,
    ended: bool,
}

impl ProcessWatch {
    pub fn new(pid: u32) -> io::Result<Self> {
        let pid = i32::try_from(pid).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid out of range"))?;
        let mut backend = ExitBackend::new()?;
        let watch = backend.watch(pid);
        Ok(Self::with(pid, backend, watch))
    }

    fn with(pid: i32, backend: ExitBackend, watch: Watch) -> Self {
        let (polled, ended) = match watch {
            Watch::Registered => (false, false),
            Watch::Gone => (false, true),
            Watch::Poll => (true, false),
        };
        ProcessWatch { pid, backend, polled, ended }
    }

    /// Whether the process has ended. Once true, always true, whoever holds the number next.
    pub fn ended(&mut self) -> bool {
        if !self.ended {
            self.ended = if self.polled { !crate::os::pid_alive(self.pid as u32) } else { self.backend.ended(self.pid) };
        }
        self.ended
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #840 item 8, review: only "no such process" means gone; any other failure to register
    /// falls back to polling the number instead of reading as an end.
    #[test]
    fn only_esrch_means_a_process_has_gone() {
        assert!(matches!(Watch::after_error(io::Error::from_raw_os_error(libc::ESRCH)), Watch::Gone));
        for e in [libc::ENOSYS, libc::EMFILE, libc::EINVAL, libc::EPERM] {
            assert!(matches!(Watch::after_error(io::Error::from_raw_os_error(e)), Watch::Poll), "errno {e}");
        }
    }

    /// The fallback: a process watched by polling its number is running until it ends.
    #[test]
    fn a_polled_process_watch_sees_the_process_end() {
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "sleep 0.2"]).spawn().unwrap();
        let pid = child.id() as i32;
        let mut w = ProcessWatch::with(pid, ExitBackend::new().unwrap(), Watch::Poll);
        assert!(!w.ended(), "a running process read as ended");
        child.wait().unwrap();
        assert!(w.ended(), "the end of a polled process was not seen");
    }

    /// A process that is not our child (the shell that started it has exited) is seen to end, as a handed-over host is
    #[test]
    fn the_end_of_a_process_that_is_not_our_child_is_seen() {
        let out = std::process::Command::new("/bin/sh").args(["-c", "sleep 0.3 >/dev/null 2>&1 & echo $!"]).output().unwrap();
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let mut w = ProcessWatch::new(pid).unwrap();
        assert!(!w.ended(), "still running");
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !w.ended() && std::time::Instant::now() < end {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(w.ended(), "the end was not seen");
    }
}
