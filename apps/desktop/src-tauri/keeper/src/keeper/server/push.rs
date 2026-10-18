//! What the keeper writes to an attached window, written by a thread of the window's own instead of
//! under the keeper's state lock (#840 item 5).
//!
//! A push used to be a blocking write inside `Keeper::broadcast`, which runs under the state lock: a
//! window that stopped reading held every push, every request and the host's status sink for up to
//! `WINDOW_WRITE_TIMEOUT` on each change. Now `broadcast` only queues the line. Each window's writer
//! sends its queue in order; a status view still waiting when a newer one comes is replaced by it
//! (each view is whole, so only the newest matters), while an answer (`attach`'s) is never dropped. A
//! view of another swap phase does not replace one waiting: a swap's phases follow each other at once
//! (standby, then draining), and a window told only the later one missed a phase (#368). A swap has a
//! handful of phases, so this keeps the queue as short as before. A write that fails or times out
//! closes the window, as before (`on_fail`).
//!
//! A keeper handoff freezes every writer once its queue has gone out (`freeze`): the windows'
//! sockets change hands, and two keepers writing one socket could interleave half lines.

use std::collections::VecDeque;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::super::accept;
use super::super::swap::Phase;

/// What a queued line is: whether a newer one may replace it while it waits.
#[derive(Clone, Copy, PartialEq)]
enum Line {
    /// An answer, which nothing replaces
    Answer,
    /// A status view, during the swap phase it shows (or none): a newer view of the same phase replaces it
    Status(Option<Phase>),
}

#[derive(Default)]
struct PushState {
    /// Lines to write, oldest first.
    queue: VecDeque<(Line, Vec<u8>)>,
    writing: bool,
    frozen: bool,
    /// The window is gone or its write failed: nothing more is written, and the writer ends.
    closed: bool,
}

pub(in crate::keeper) struct Pusher {
    st: Mutex<PushState>,
    cv: Condvar,
}

impl Pusher {
    /**
     * Starts the writer for `stream`. `on_fail` runs once, from the writer, when a write fails; it
     * runs before anything else learns of the failure, so it can record why the window is being
     * closed before the window's reader sees its connection end.
     */
    pub(in crate::keeper) fn start(stream: Arc<UnixStream>, on_fail: impl FnOnce(&std::io::Error) + Send + 'static) -> std::io::Result<Arc<Pusher>> {
        let p = Arc::new(Pusher { st: Mutex::new(PushState::default()), cv: Condvar::new() });
        let writer = p.clone();
        accept::spawn("keeper-window-push", move || writer.run(stream, on_fail))?;
        Ok(p)
    }

    /// Queues a status view, replacing one of the same swap phase (`phase`, none outside a swap)
    /// still waiting at the back of the queue.
    pub(in crate::keeper) fn status(&self, line: Vec<u8>, phase: Option<Phase>) {
        self.queue(Line::Status(phase), line);
    }

    /// Queues an answer, which no later line replaces.
    pub(in crate::keeper) fn answer(&self, line: Vec<u8>) {
        self.queue(Line::Answer, line);
    }

    fn queue(&self, kind: Line, line: Vec<u8>) {
        let Ok(mut st) = self.st.lock() else { return };
        if st.closed {
            return;
        }
        match st.queue.back_mut() {
            Some((waiting_kind, waiting)) if kind != Line::Answer && *waiting_kind == kind => *waiting = line,
            _ => st.queue.push_back((kind, line)),
        }
        self.cv.notify_all();
    }

    /// Ends the writer; what is still queued is not written.
    pub(in crate::keeper) fn close(&self) {
        if let Ok(mut st) = self.st.lock() {
            st.closed = true;
            st.queue.clear();
        }
        self.cv.notify_all();
    }

    /**
     * Waits until everything queued has been written (or the window was closed), then stops the
     * writer until `thaw`. False if it is still writing at `deadline`; it is not frozen then.
     */
    pub(in crate::keeper) fn freeze(&self, deadline: Instant) -> bool {
        let Ok(mut st) = self.st.lock() else { return false };
        while !st.closed && (st.writing || !st.queue.is_empty()) {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { return false };
            let Ok((next, _)) = self.cv.wait_timeout(st, left) else { return false };
            st = next;
        }
        st.frozen = true;
        true
    }

    pub(in crate::keeper) fn thaw(&self) {
        if let Ok(mut st) = self.st.lock() {
            st.frozen = false;
        }
        self.cv.notify_all();
    }

    fn run(&self, stream: Arc<UnixStream>, on_fail: impl FnOnce(&std::io::Error)) {
        loop {
            let line = {
                let Ok(mut st) = self.st.lock() else { return };
                loop {
                    if st.closed {
                        return;
                    }
                    if !st.frozen {
                        if let Some((_, line)) = st.queue.pop_front() {
                            st.writing = true;
                            break line;
                        }
                    }
                    let Ok((next, _)) = self.cv.wait_timeout(st, Duration::from_secs(60)) else { return };
                    st = next;
                }
            };
            let written = (&*stream).write_all(&line);
            if let Ok(mut st) = self.st.lock() {
                st.writing = false;
                if written.is_err() {
                    st.closed = true;
                    st.queue.clear();
                }
            }
            self.cv.notify_all();
            if let Err(e) = written {
                on_fail(&e);
                let _ = stream.shutdown(std::net::Shutdown::Both);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    /// A window that reads slowly gets the newest status, not every one queued meanwhile, and an
    /// answer is never replaced.
    #[test]
    fn a_waiting_status_is_replaced_by_a_newer_one_but_an_answer_is_kept() {
        let (window, keeper_end) = UnixStream::pair().unwrap();
        let p = Pusher::start(Arc::new(keeper_end), |_| {}).unwrap();
        assert!(p.freeze(Instant::now() + Duration::from_secs(5)));
        p.answer(b"answer\n".to_vec());
        p.status(b"one\n".to_vec(), None);
        p.status(b"two\n".to_vec(), None);
        p.answer(b"answer 2\n".to_vec());
        p.status(b"three\n".to_vec(), None);
        p.thaw();
        let mut lines = BufReader::new(window).lines();
        let got: Vec<String> = (0..4).map(|_| lines.next().unwrap().unwrap()).collect();
        assert_eq!(got, ["answer", "two", "answer 2", "three"]);
        p.close();
    }

    /// #368: a swap tells its phases one right after another (standby, then draining at once). A
    /// window whose writer had not sent the first yet got only the second, so the attached app was
    /// never told the new host stood by. A view of another phase is kept; within a phase (or with
    /// no swap) the newest still replaces the one waiting.
    #[test]
    fn a_status_of_another_swap_phase_is_kept_not_replaced() {
        let (window, keeper_end) = UnixStream::pair().unwrap();
        let p = Pusher::start(Arc::new(keeper_end), |_| {}).unwrap();
        assert!(p.freeze(Instant::now() + Duration::from_secs(5)));
        let status = |line: &str, phase: Option<Phase>| p.status(format!("{line}\n").into_bytes(), phase);
        status("idle", None);
        status("idle again", None);
        status("starting", Some(Phase::Starting));
        status("starting, host restarting", Some(Phase::Starting));
        status("standby", Some(Phase::Standby));
        status("draining", Some(Phase::Draining));
        status("done", Some(Phase::Done));
        status("done, host ready", Some(Phase::Done));
        p.thaw();
        // Read until nothing more comes, so lines that were replaced fail the comparison rather than hang it
        window.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let got: Vec<String> = BufReader::new(window).lines().map_while(Result::ok).take(6).collect();
        assert_eq!(got, ["idle again", "starting, host restarting", "standby", "draining", "done, host ready"]);
        p.close();
    }

    /// Whether the window has anything to read within `wait`.
    fn readable(window: &UnixStream, wait: Duration) -> bool {
        use std::os::fd::AsRawFd;
        let mut p = libc::pollfd { fd: window.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd.
        unsafe { libc::poll(&mut p, 1, wait.as_millis() as i32) == 1 }
    }

    /// #840 item 5, review: a freeze waits for a stalled window's write only until its deadline and
    /// then gives up, leaving the writer running (the handoff rolls back); a writer that froze writes
    /// nothing until it is thawed, and then sends what was queued meanwhile.
    #[test]
    fn a_freeze_gives_up_on_a_stalled_window_and_a_frozen_writer_writes_nothing() {
        // Stalled: a line far larger than the socket's buffers, to a window that does not read yet
        let (stalled, keeper_end) = UnixStream::pair().unwrap();
        keeper_end.set_write_timeout(Some(Duration::from_secs(10))).unwrap();
        let p = Pusher::start(Arc::new(keeper_end), |_| {}).unwrap();
        let mut big = vec![b'x'; 4 * 1024 * 1024];
        big.push(b'\n');
        p.answer(big);
        let began = Instant::now();
        assert!(!p.freeze(Instant::now() + Duration::from_millis(300)), "a freeze waited out a stalled write");
        assert!(began.elapsed() < Duration::from_secs(5), "{:?}", began.elapsed());
        // Not frozen: once the window reads, the rest goes out, and later lines too
        p.status(b"after\n".to_vec(), None);
        let mut lines = BufReader::new(stalled.try_clone().unwrap()).lines();
        assert_eq!(lines.next().unwrap().unwrap().len(), 4 * 1024 * 1024);
        assert_eq!(lines.next().unwrap().unwrap(), "after", "a writer whose freeze gave up stopped writing");

        // Idle: the freeze holds, nothing is written while frozen, and a thaw (the rollback)
        // sends what was queued
        assert!(p.freeze(Instant::now() + Duration::from_secs(5)));
        p.status(b"while frozen\n".to_vec(), None);
        assert!(!readable(&stalled, Duration::from_millis(300)), "a frozen writer wrote");
        p.thaw();
        assert!(readable(&stalled, Duration::from_secs(5)), "a thawed writer did not send what was queued");
        assert_eq!(lines.next().unwrap().unwrap(), "while frozen");
        p.close();
    }
}
