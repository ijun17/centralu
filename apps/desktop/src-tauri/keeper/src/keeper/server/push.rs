//! What the keeper writes to an attached window, written by a thread of the window's own instead of
//! under the keeper's state lock (#840 item 5).
//!
//! A push used to be a blocking write inside `Keeper::broadcast`, which runs under the state lock: a
//! window that stopped reading held every push, every request and the host's status sink for up to
//! `WINDOW_WRITE_TIMEOUT` on each change. Now `broadcast` only queues the line. Each window's writer
//! sends its queue in order; a status view still waiting when a newer one comes is replaced by it
//! (each view is whole, so only the newest matters), while an answer (`attach`'s) is never dropped. A
//! write that fails or times out closes the window, as before (`on_fail`).

use std::collections::VecDeque;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::super::accept;

/// What a queued line is: whether a newer one may replace it while it waits.
#[derive(Clone, Copy, PartialEq)]
enum Line {
    /// An answer, which nothing replaces
    Answer,
    /// A status view: a newer one replaces it
    Status,
}

#[derive(Default)]
struct PushState {
    /// Lines to write, oldest first.
    queue: VecDeque<(Line, Vec<u8>)>,
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
        let p = Pusher::new();
        let writer = p.clone();
        accept::spawn("keeper-window-push", move || writer.run(stream, on_fail))?;
        Ok(p)
    }

    /// A writer not started yet: what is queued waits for `run`.
    fn new() -> Arc<Pusher> {
        Arc::new(Pusher { st: Mutex::new(PushState::default()), cv: Condvar::new() })
    }

    /// Queues a status view, replacing one still waiting at the back of the queue.
    pub(in crate::keeper) fn status(&self, line: Vec<u8>) {
        self.queue(Line::Status, line);
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

    fn run(&self, stream: Arc<UnixStream>, on_fail: impl FnOnce(&std::io::Error)) {
        loop {
            let line = {
                let Ok(mut st) = self.st.lock() else { return };
                loop {
                    if st.closed {
                        return;
                    }
                    if let Some((_, line)) = st.queue.pop_front() {
                        break line;
                    }
                    let Ok((next, _)) = self.cv.wait_timeout(st, Duration::from_secs(60)) else { return };
                    st = next;
                }
            };
            let written = (&*stream).write_all(&line);
            if let Err(e) = written {
                if let Ok(mut st) = self.st.lock() {
                    st.closed = true;
                    st.queue.clear();
                }
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
        let p = Pusher::new();
        p.answer(b"answer\n".to_vec());
        p.status(b"one\n".to_vec());
        p.status(b"two\n".to_vec());
        p.answer(b"answer 2\n".to_vec());
        p.status(b"three\n".to_vec());
        let writer = p.clone();
        std::thread::spawn(move || writer.run(Arc::new(keeper_end), |_| {}));
        let mut lines = BufReader::new(window).lines();
        let got: Vec<String> = (0..4).map(|_| lines.next().unwrap().unwrap()).collect();
        assert_eq!(got, ["answer", "two", "answer 2", "three"]);
        p.close();
    }

    /// #840 item 5: a window that stopped reading holds up only its own writer; the keeper queues on, and once the window
    /// reads it gets what is left.
    #[test]
    fn a_stalled_window_holds_up_only_its_own_writer() {
        let (stalled, keeper_end) = UnixStream::pair().unwrap();
        keeper_end.set_write_timeout(Some(Duration::from_secs(10))).unwrap();
        let p = Pusher::start(Arc::new(keeper_end), |_| {}).unwrap();
        let mut big = vec![b'x'; 4 * 1024 * 1024];
        big.push(b'\n');
        p.answer(big);
        let began = std::time::Instant::now();
        p.status(b"after\n".to_vec());
        assert!(began.elapsed() < Duration::from_secs(1), "queueing waited for the window: {:?}", began.elapsed());
        let mut lines = BufReader::new(stalled).lines();
        assert_eq!(lines.next().unwrap().unwrap().len(), 4 * 1024 * 1024);
        assert_eq!(lines.next().unwrap().unwrap(), "after");
        p.close();
    }
}
