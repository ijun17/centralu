//! What the keeper's three accept loops (`keeper.sock`, `children.sock`, the front door) do when
//! `accept` fails (#840 item 3).
//!
//! The listeners are polled, and a poll on a listener with a connection waiting stays readable
//! until that connection is accepted. When `accept` fails for want of a descriptor (`EMFILE`, a
//! keeper started from Finder has a soft limit of 256), the connection stays in the queue, so every
//! loop came straight back to the same failure: one core spinning and the log growing by thousands
//! of lines a second, until a descriptor came free. Now a failure leaves the listener alone for a
//! moment, and the log says it once (and then once every `LOG_EVERY`, with the count) instead of
//! every time.
//!
//! A thread per connection is started with `spawn`, not `thread::spawn`: the latter panics when the
//! OS refuses a thread, and the release build has `panic = "abort"`, which ends the keeper and with
//! it the host, every agent and every terminal.

use std::io;
use std::thread;
use std::time::{Duration, Instant};

/// How long a listener is left alone after an `accept` that failed for want of a resource. The
/// connection waits in the listen queue meanwhile.
pub(super) const PAUSE: Duration = Duration::from_millis(100);

/// How often a run of failures is written to the log after its first line.
const LOG_EVERY: Duration = Duration::from_secs(10);

/// One accept loop's failures: what to log and how long to wait.
pub(super) struct AcceptErrors {
    /// The loop's own log, which names the listener.
    log: fn(&str),
    failures: u64,
    logged: u64,
    last_log: Option<Instant>,
}

impl AcceptErrors {
    pub(super) fn new(log: fn(&str)) -> Self {
        AcceptErrors { log, failures: 0, logged: 0, last_log: None }
    }

    /// An `accept` that failed with `e` (not `WouldBlock`). Returns how long to leave the listener
    /// alone: `PAUSE` when the failure will repeat until something is freed, nothing for one that
    /// concerned only the connection it was about.
    pub(super) fn failed(&mut self, e: &io::Error) -> Duration {
        if e.kind() == io::ErrorKind::Interrupted {
            return Duration::ZERO;
        }
        self.failures += 1;
        let now = Instant::now();
        if self.last_log.is_none_or(|t| now.duration_since(t) >= LOG_EVERY) {
            let earlier = self.failures - 1 - self.logged;
            let more = if earlier > 0 { format!(" ({earlier} more since the last line)") } else { String::new() };
            (self.log)(&format!("accept failed: {e}{more}"));
            self.logged = self.failures;
            self.last_log = Some(now);
        }
        if e.kind() == io::ErrorKind::ConnectionAborted {
            Duration::ZERO
        } else {
            PAUSE
        }
    }

    /// An `accept` that worked: a run of failures, if there was one, is over.
    pub(super) fn accepted(&mut self) {
        if self.failures > 0 {
            (self.log)(&format!("accepting again after {} failed accepts", self.failures));
            *self = AcceptErrors::new(self.log);
        }
    }
}

/// Starts a thread for one connection, or returns why the OS refused one (the caller drops the
/// connection and undoes its bookkeeping) instead of panicking (`thread::spawn`).
pub(super) fn spawn<F: FnOnce() + Send + 'static>(name: &str, f: F) -> io::Result<()> {
    thread::Builder::new().name(name.to_string()).spawn(f).map(|_| ())
}

/// Tests that need the process to run out of descriptors run in a process of their own: the limit
/// is per process, and lowering it in the test binary would fail every other test running then.
#[cfg(test)]
pub(crate) mod few_descriptors {
    use std::fs::File;
    use std::process::Command;

    const ENV: &str = "CC_KEEPER_FEW_DESCRIPTORS_TEST";

    /// Runs the test named `name` (its full path) again in a child process and returns its stderr,
    /// or, in that child, returns None so the test goes on to do its part.
    pub(crate) fn rerun(name: &str) -> Option<String> {
        if std::env::var(ENV).as_deref() == Ok(name) {
            return None;
        }
        let out = Command::new(std::env::current_exe().unwrap())
            .args([name, "--exact", "--nocapture", "--test-threads=1"])
            .env(ENV, name)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout);
        // Not the exit status alone: a test whose code under test ends the process (`exit(0)`)
        // would read as a pass.
        assert!(out.status.success() && stdout.contains("1 passed"), "the child run failed:\n{stdout}\n{stderr}");
        Some(stderr)
    }

    /// This process's soft descriptor limit.
    pub(crate) fn soft_limit() -> u64 {
        let mut cur = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: a valid out-pointer.
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut cur) }, 0);
        cur.rlim_cur
    }

    /// Lowers this process's soft descriptor limit to `limit`.
    pub(crate) fn lower(limit: u64) {
        let mut cur = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: valid pointers to rlimit structs.
        unsafe {
            libc::getrlimit(libc::RLIMIT_NOFILE, &mut cur);
            let lim = libc::rlimit { rlim_cur: limit as libc::rlim_t, rlim_max: cur.rlim_max };
            assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &lim), 0, "lower the descriptor limit");
        }
    }

    /**
     * What a second out of descriptors cost, from the child run's log: a few log lines (the flood), and
     * a few failed accepts in all (the spin, which a throttled log alone would hide), counted by the
     * line that ends the run once a descriptor is free. Ten tries a second is the 100 ms pause; on Linux
     * the loop without it tried about 100,000 times. (macOS drops the waiting connection with its
     * first failed accept, so there it fails once whatever the loop does.)
     */
    pub(crate) fn assert_accepts_paused(stderr: &str, what: &str) {
        let lines = stderr.lines().filter(|l| l.contains("accept failed")).count();
        assert!(lines >= 1, "the failure is said: {stderr}");
        assert!(lines <= 3, "{lines} lines of accept failures in a second: {what}'s log flooded");
        let tries: u64 = stderr
            .lines()
            .find_map(|l| l.split("accepting again after ").nth(1)?.split(' ').next()?.parse().ok())
            .unwrap_or_else(|| panic!("no line ends the run of failed accepts: {stderr}"));
        assert!(tries <= 30, "{tries} failed accepts in a second: {what} spun");
    }

    /// Lowers this process's soft descriptor limit to `limit` and opens files until it is reached.
    /// Dropping what it returns frees them.
    pub(crate) fn exhaust(limit: u64) -> Vec<File> {
        lower(limit);
        let mut held = Vec::new();
        while let Ok(f) = File::open("/dev/null") {
            held.push(f);
        }
        held
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());
    fn record(l: &str) {
        LINES.lock().unwrap().push(l.to_string());
    }

    #[test]
    fn a_run_of_failures_pauses_the_listener_and_is_logged_once() {
        let mut e = AcceptErrors::new(record);
        let emfile = io::Error::from_raw_os_error(libc::EMFILE);
        assert_eq!(e.failed(&emfile), PAUSE, "out of descriptors: leave the listener alone");
        for _ in 0..1000 {
            e.failed(&emfile);
        }
        assert_eq!(e.failed(&io::Error::from(io::ErrorKind::ConnectionAborted)), Duration::ZERO, "one connection's own failure");
        assert_eq!(e.failed(&io::Error::from(io::ErrorKind::Interrupted)), Duration::ZERO);
        e.accepted();
        let lines = LINES.lock().unwrap().clone();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].starts_with("accept failed: "), "{lines:?}");
        assert_eq!(lines[1], "accepting again after 1002 failed accepts");
    }

    /// The keeper raises its soft descriptor limit as it starts, so 256 from Finder is not where it
    /// runs out (#840 item 3), and never lowers one that is already higher.
    #[test]
    fn the_keeper_raises_a_low_descriptor_limit() {
        if few_descriptors::rerun("keeper::accept::tests::the_keeper_raises_a_low_descriptor_limit").is_some() {
            return;
        }
        few_descriptors::lower(256);
        let raised = crate::os::raise_descriptor_limit().expect("raised");
        assert_eq!(raised.0, 256);
        assert!(raised.1 > 256 && raised.1 <= crate::os::DESCRIPTOR_LIMIT, "{raised:?}");
        assert_eq!(few_descriptors::soft_limit(), raised.1);
        assert_eq!(crate::os::raise_descriptor_limit(), None, "already as high as it goes");
        // What the keeper starts gets the limit it had before back (#840 item 3, review).
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", "ulimit -n"]);
        crate::os::original_descriptor_limit(&mut c);
        let out = c.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "256", "a child starts with the limit from before");
        let mut agent = crate::os::children::spawn_pipes("/bin/sh", &["-c".into(), "ulimit -n".into()], "/tmp", &Default::default()).unwrap();
        let mut b = [0u8; 16];
        let mut got = String::new();
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while !got.ends_with('\n') && std::time::Instant::now() < end {
            match crate::os::children::read_fd(std::os::fd::AsRawFd::as_raw_fd(&agent.out), &mut b) {
                Ok(0) => break,
                Ok(n) => got.push_str(&String::from_utf8_lossy(&b[..n])),
                Err(_) => thread::sleep(Duration::from_millis(10)),
            }
        }
        drop(agent.stdin.take());
        assert_eq!(got.trim(), "256", "so does a child the keeper holds");
    }
}
