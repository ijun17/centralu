//! What the keeper keeps of a child's output while nobody, or a slow host, is reading it.
//!
//! One buffer per output stream, with one of three policies. Which one a stream gets follows from
//! what losing a byte of it would cost:
//!
//! | policy | stream | when full | after a byte is sent |
//! |---|---|---|---|
//! | `Lines` | an agent's stdout (claude, codex app-server) | stop reading the child: the pipe fills and the child waits | dropped, up to the last whole line |
//! | `Ring` | a pty master (terminal, project command) | drop the oldest bytes | kept, so a new host can replay the screen |
//! | `Tail` | an agent's stderr | drop the oldest bytes | dropped |
//!
//! - **An agent's stdout is a protocol** (newline-delimited JSON). A dropped byte breaks a frame, so
//!   it is never dropped: past the cap the keeper simply stops reading and the child blocks on its
//!   own write, which is how a pipe behaves with nobody reading (Claude was measured buffering 60 s
//!   with stdout unread, #280). The cap is large because one codex `thread/resume` answer was
//!   measured at 23 MB on a single line.
//! - **It is handed over in whole lines.** Only bytes up to the last newline go to a reader, so a
//!   host that goes away between two lines leaves the next host a stream that starts on a frame. A
//!   partial write can still leave the reader mid-line; if that reader is lost, the next one is sent
//!   the whole line again from its start (`reader_lost`), and a reader that detaches cleanly is
//!   first sent the rest of the line (`sendable(true)`).
//! - **A pty is drained whatever happens.** A session leader cannot finish exiting while its output
//!   is unread (measured in #280: bash sat in state `?Es` for over 5 s), so a pty is read
//!   continuously and the oldest bytes give way. What is kept is what a terminal's scrollback keeps.
//! - **stderr is diagnostics.** Blocking a child on it would stall the agent over a log line.

/// Capacity of an agent's stdout buffer before the keeper stops reading the child.
pub const LINES_CAP: usize = 64 * 1024 * 1024;
/// A pty's retained output: the same 256 KiB the host keeps as a terminal's scrollback.
pub const RING_CAP: usize = 256 * 1024;
/// An agent's stderr tail.
pub const TAIL_CAP: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Lines { cap: usize },
    Ring { cap: usize },
    Tail { cap: usize },
}

#[derive(Debug)]
pub struct OutBuf {
    policy: Policy,
    /// Bytes from `head` on are live; the ones before it are already dropped and wait for a
    /// compaction. Contiguous, so a send is one slice.
    data: Vec<u8>,
    head: usize,
    /// Absolute stream offset of `data[head]`.
    base: u64,
    /// Absolute offset of the next byte to send to the reader.
    cursor: u64,
    /// `Lines`: absolute offset where the line holding `cursor` starts (`cursor` itself when the
    /// reader is on a boundary).
    line_start: u64,
    /// The child's end of this stream has closed.
    pub eof: bool,
    /// Bytes dropped by `Ring`/`Tail` before anyone read them.
    pub dropped: u64,
}

impl OutBuf {
    pub fn new(policy: Policy) -> Self {
        OutBuf { policy, data: Vec::new(), head: 0, base: 0, cursor: 0, line_start: 0, eof: false, dropped: 0 }
    }

    fn cap(&self) -> usize {
        match self.policy {
            Policy::Lines { cap } | Policy::Ring { cap } | Policy::Tail { cap } => cap,
        }
    }

    fn live(&self) -> &[u8] {
        &self.data[self.head..]
    }

    pub fn len(&self) -> usize {
        self.data.len() - self.head
    }

    fn end(&self) -> u64 {
        self.base + self.len() as u64
    }

    /// Bytes not yet sent to a reader.
    pub fn unsent(&self) -> usize {
        (self.end() - self.cursor.max(self.base)) as usize
    }

    /// Whether the keeper should keep reading the child. Only `Lines` ever says no.
    pub fn wants_input(&self) -> bool {
        match self.policy {
            Policy::Lines { cap } => self.len() < cap,
            _ => true,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.data.extend_from_slice(bytes);
        if matches!(self.policy, Policy::Ring { .. } | Policy::Tail { .. }) {
            let over = self.len().saturating_sub(self.cap());
            if over > 0 {
                let unread_lost = (self.base + over as u64).saturating_sub(self.cursor.max(self.base));
                self.dropped += unread_lost;
                self.drop_front(over);
                if self.cursor < self.base {
                    self.cursor = self.base;
                }
            }
        }
    }

    fn drop_front(&mut self, n: usize) {
        self.head += n;
        self.base += n as u64;
        // Compact once the dead prefix is both large and most of the vector, so a steady stream
        // costs one memmove per buffer's worth of data rather than one per read.
        if self.head > 64 * 1024 && self.head * 2 > self.data.len() {
            self.data.drain(..self.head);
            self.head = 0;
        }
    }

    /// The next bytes to send. `finishing` is a reader that asked to detach: it gets the rest of
    /// the line it is in the middle of, and nothing after that.
    pub fn sendable(&self, finishing: bool) -> &[u8] {
        let from = self.cursor.max(self.base);
        let start = (from - self.base) as usize;
        let rest = &self.live()[start..];
        let n = match self.policy {
            Policy::Ring { .. } | Policy::Tail { .. } => {
                if finishing {
                    0
                } else {
                    rest.len()
                }
            }
            Policy::Lines { cap } => {
                if finishing {
                    if self.cursor == self.line_start {
                        0
                    } else {
                        match rest.iter().position(|&b| b == b'\n') {
                            Some(i) => i + 1,
                            None if self.eof => rest.len(),
                            None => 0,
                        }
                    }
                } else {
                    match rest.iter().rposition(|&b| b == b'\n') {
                        Some(i) => i + 1,
                        // A line longer than the whole buffer, or the last words before EOF: send
                        // what there is rather than wait forever for a newline that cannot fit.
                        None if self.eof || self.len() >= cap => rest.len(),
                        None => 0,
                    }
                }
            }
        };
        &rest[..n]
    }

    /// `n` bytes of `sendable()` reached the reader's socket.
    pub fn sent(&mut self, n: usize) {
        if n == 0 {
            return;
        }
        let from = self.cursor.max(self.base);
        let start = (from - self.base) as usize;
        let chunk_last_nl = self.live()[start..start + n].iter().rposition(|&b| b == b'\n');
        self.cursor = from + n as u64;
        match self.policy {
            Policy::Lines { .. } => {
                if let Some(i) = chunk_last_nl {
                    self.line_start = from + i as u64 + 1;
                }
                if self.eof && self.cursor == self.end() {
                    self.line_start = self.cursor;
                }
                let drop = (self.line_start - self.base) as usize;
                self.drop_front(drop);
            }
            Policy::Tail { .. } => {
                let drop = (self.cursor - self.base) as usize;
                self.drop_front(drop);
            }
            Policy::Ring { .. } => {}
        }
    }

    /// A new reader attached. A pty replays what it kept; the other streams carry on from the
    /// first byte nobody has been sent.
    pub fn attached(&mut self) {
        if let Policy::Ring { .. } = self.policy {
            self.cursor = self.base;
        }
    }

    /// The reader went away without detaching. A line it was sent only part of is sent again,
    /// whole, to the next one.
    pub fn reader_lost(&mut self) {
        if let Policy::Lines { .. } = self.policy {
            self.cursor = self.line_start;
        }
    }

    /// Whether a detaching reader has been sent everything it is owed.
    pub fn at_boundary(&self) -> bool {
        match self.policy {
            Policy::Lines { .. } => self.cursor == self.line_start || (self.eof && self.cursor >= self.end()),
            _ => true,
        }
    }

    /// The child closed this stream and the reader has everything.
    pub fn drained(&self) -> bool {
        self.eof && self.cursor.max(self.base) >= self.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(cap: usize) -> OutBuf {
        OutBuf::new(Policy::Lines { cap })
    }

    #[test]
    fn an_agent_stream_is_handed_over_in_whole_lines() {
        let mut b = lines(1024);
        b.push(b"{\"a\":1}\n{\"b\":");
        assert_eq!(b.sendable(false), b"{\"a\":1}\n", "the half line waits for its newline");
        b.sent(8);
        assert_eq!(b.sendable(false), b"");
        b.push(b"2}\n");
        assert_eq!(b.sendable(false), b"{\"b\":2}\n");
    }

    /// A host that dies after its socket took half a line must not leave the next host a stream
    /// that starts mid-frame.
    #[test]
    fn a_line_half_sent_to_a_lost_reader_is_sent_whole_to_the_next() {
        let mut b = lines(1024);
        b.push(b"one\ntwo-long-line\n");
        b.sent(4 + 3); // "one\n" and "two" reached the old reader's socket
        b.reader_lost();
        b.attached();
        assert_eq!(b.sendable(false), b"two-long-line\n");
    }

    #[test]
    fn a_detaching_reader_gets_the_rest_of_its_line_and_no_more() {
        let mut b = lines(1024);
        b.push(b"one\ntwo\nthree\n");
        b.sent(6); // "one\n" + "tw"
        assert!(!b.at_boundary());
        assert_eq!(b.sendable(true), b"o\n");
        b.sent(2);
        assert!(b.at_boundary());
        assert_eq!(b.sendable(true), b"", "the next line belongs to the next reader");
        assert_eq!(b.sendable(false), b"three\n");
    }

    #[test]
    fn a_full_agent_stream_stops_reading_instead_of_dropping() {
        let mut b = lines(8);
        b.push(b"abc\ndefgh");
        assert!(!b.wants_input(), "at the cap the child is left to block on its pipe");
        assert_eq!(b.dropped, 0);
        b.sent(b.sendable(false).len());
        assert!(b.wants_input(), "sending a line makes room again");
    }

    /// A single line larger than the buffer (codex answers can be 23 MB on one line) would
    /// otherwise wait forever for a newline that cannot fit.
    #[test]
    fn a_line_longer_than_the_buffer_is_sent_rather_than_stuck() {
        let mut b = lines(4);
        b.push(b"abcdef");
        assert_eq!(b.sendable(false), b"abcdef");
    }

    #[test]
    fn the_last_words_before_eof_are_sent_without_a_newline() {
        let mut b = lines(1024);
        b.push(b"done");
        b.eof = true;
        assert_eq!(b.sendable(false), b"done");
        b.sent(4);
        assert!(b.drained());
    }

    #[test]
    fn a_pty_keeps_its_last_bytes_and_replays_them_to_a_new_reader() {
        let mut b = OutBuf::new(Policy::Ring { cap: 8 });
        b.push(b"0123456789");
        assert_eq!(b.sendable(false), b"23456789", "the oldest bytes gave way");
        assert_eq!(b.dropped, 2);
        b.sent(8);
        assert_eq!(b.sendable(false), b"");
        b.attached();
        assert_eq!(b.sendable(false), b"23456789", "a new host sees the screen again");
    }

    #[test]
    fn a_slow_pty_reader_skips_ahead_instead_of_holding_the_child() {
        let mut b = OutBuf::new(Policy::Ring { cap: 4 });
        b.push(b"ab");
        b.sent(1);
        b.push(b"cdefgh");
        assert!(b.wants_input());
        assert_eq!(b.sendable(false), b"efgh");
    }

    #[test]
    fn stderr_keeps_only_an_unsent_tail() {
        let mut b = OutBuf::new(Policy::Tail { cap: 4 });
        b.push(b"abcdef");
        assert_eq!(b.sendable(false), b"cdef");
        b.sent(4);
        b.attached();
        assert_eq!(b.sendable(false), b"", "what was sent is not sent again");
    }

    #[test]
    fn compaction_keeps_offsets_right() {
        let mut b = lines(1 << 20);
        let line = vec![b'x'; 1023];
        for _ in 0..200 {
            b.push(&line);
            b.push(b"\n");
            let n = b.sendable(false).len();
            b.sent(n);
        }
        assert_eq!(b.len(), 0);
        b.push(b"tail\n");
        assert_eq!(b.sendable(false), b"tail\n");
    }
}
