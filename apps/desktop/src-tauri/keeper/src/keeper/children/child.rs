//! One held child: what it is, its descriptors, its buffered output, and the bytes going into it.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Kind {
    Pipes,
    Pty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Which {
    Out,
    Err,
}

/// One held child: what it is, its descriptors and its buffered output.
pub(super) struct Child {
    pub(super) kind: Kind,
    pub(super) pid: i32,
    pub(super) cmd: String,
    pub(super) args: Vec<String>,
    pub(super) cwd: String,
    pub(super) started_ms: u64,
    /// The host's own description of the child (which session, terminal or command). Opaque here:
    /// the keeper stores it and hands it back, and parses nothing in it.
    pub(super) tag: Value,
    pub(super) cols: u16,
    pub(super) rows: u16,
    /// Pipes only. A pty's input goes to `out_fd`, the master.
    pub(super) stdin: Option<OwnedFd>,
    pub(super) out_fd: Option<OwnedFd>,
    pub(super) err_fd: Option<OwnedFd>,
    pub(super) out: OutBuf,
    pub(super) err: OutBuf,
    pub(super) out_reader: Option<u64>,
    pub(super) err_reader: Option<u64>,
    /// Bytes waiting for the child's stdin. Only whole lines enter it for pipes.
    pub(super) inbuf: Vec<u8>,
    /// `close_stdin` was asked for: close it once `inbuf` is written.
    pub(super) close_stdin: bool,
    pub(super) exit: Option<ExitStatus>,
    pub(super) exited_at: Option<Instant>,
}

impl Child {
    pub(super) fn in_fd(&self) -> Option<RawFd> {
        match self.kind {
            Kind::Pty => self.out_fd.as_ref().map(|f| f.as_raw_fd()),
            Kind::Pipes => self.stdin.as_ref().map(|f| f.as_raw_fd()),
        }
    }

    pub(super) fn buf(&mut self, w: Which) -> &mut OutBuf {
        match w {
            Which::Out => &mut self.out,
            Which::Err => &mut self.err,
        }
    }

    pub(super) fn buf_ref(&self, w: Which) -> &OutBuf {
        match w {
            Which::Out => &self.out,
            Which::Err => &self.err,
        }
    }

    /// The descriptor a stream is read from, while it is open.
    pub(super) fn out_fd(&self, w: Which) -> Option<RawFd> {
        match w {
            Which::Out => self.out_fd.as_ref(),
            Which::Err => self.err_fd.as_ref(),
        }
        .map(|f| f.as_raw_fd())
    }

    /// The stream ended: what is buffered is all there will be.
    pub(super) fn end_stream(&mut self, w: Which) {
        self.buf(w).eof = true;
        match w {
            Which::Out => self.out_fd = None,
            Which::Err => self.err_fd = None,
        }
    }

    pub(super) fn reader(&mut self, w: Which) -> &mut Option<u64> {
        match w {
            Which::Out => &mut self.out_reader,
            Which::Err => &mut self.err_reader,
        }
    }

    pub(super) fn info(&self, n: u64) -> Value {
        json!({
            "id": child_id(n),
            "kind": match self.kind { Kind::Pipes => "pipes", Kind::Pty => "pty" },
            "pid": self.pid,
            "cmd": self.cmd,
            "args": self.args,
            "cwd": self.cwd,
            "startedAt": self.started_ms,
            "alive": self.exit.is_none(),
            "exit": self.exit,
            "tag": self.tag,
            "cols": self.cols,
            "rows": self.rows,
            "buffered": self.out.unsent(),
            "attached": self.out_reader.is_some(),
        })
    }
}

pub(super) fn child_id(n: u64) -> String {
    format!("c{n}")
}

pub(super) fn parse_child_id(v: Option<&Value>) -> Option<u64> {
    v?.as_str()?.strip_prefix('c')?.parse().ok()
}

/// Moves a connection's bytes into the child's input. Only whole lines go to an agent's stdin, so
/// a host that dies half way through writing a request never leaves claude or codex a torn line.
pub(super) fn attach_input(c: &mut Child, which: Which, rbuf: &mut Vec<u8>) {
    if which == Which::Err || c.in_fd().is_none() || c.exit.is_some() {
        rbuf.clear();
        return;
    }
    let room = IN_CAP.saturating_sub(c.inbuf.len());
    if room == 0 {
        return;
    }
    match c.kind {
        Kind::Pty => {
            let k = rbuf.len().min(room);
            c.inbuf.extend(rbuf.drain(..k));
        }
        Kind::Pipes => match rbuf.iter().rposition(|&b| b == b'\n') {
            Some(i) => c.inbuf.extend(rbuf.drain(..=i)),
            // A single line longer than the cap would otherwise wait forever.
            None if rbuf.len() >= IN_CAP => c.inbuf.append(rbuf),
            None => {}
        },
    }
}

pub(super) fn write_inbuf(c: &mut Child) {
    let Some(fd) = c.in_fd() else {
        c.inbuf.clear();
        return;
    };
    while !c.inbuf.is_empty() {
        match proc::write_fd(fd, &c.inbuf) {
            Ok(0) => break,
            Ok(k) => {
                c.inbuf.drain(..k);
                buffer::give_back(&mut c.inbuf);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            // EPIPE: the child is not reading any more.
            Err(_) => {
                c.inbuf.clear();
                if c.kind == Kind::Pipes {
                    c.stdin = None;
                }
                break;
            }
        }
    }
    if c.inbuf.is_empty() && c.close_stdin && c.kind == Kind::Pipes {
        c.stdin = None;
    }
}
