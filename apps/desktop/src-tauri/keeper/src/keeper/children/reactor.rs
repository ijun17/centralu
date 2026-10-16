//! The reactor: one `poll` loop on one thread owning every descriptor of the child service, the
//! connections it accepts and the bytes it moves between them and the children.

use super::*;

pub(super) enum Role {
    /// No first line yet.
    Hello,
    Control,
    Attach { child: u64, which: Which, detaching: bool },
}

pub(super) struct Conn {
    pub(super) stream: UnixStream,
    pub(super) role: Role,
    pub(super) rbuf: Vec<u8>,
    pub(super) wbuf: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Flush {
    Keep,
    /// Done with this reader on purpose (detached, or the stream ended and was all sent).
    Close,
    /// The reader is gone.
    Lost,
}

#[derive(Clone, Copy)]
pub(super) enum Tok {
    Listener,
    Wake,
    Exit,
    Out(u64),
    Err(u64),
    In(u64),
    Conn(u64),
}

pub(super) struct Reactor {
    pub(super) listener: UnixListener,
    pub(super) wake: OwnedFd,
    pub(super) shared: Arc<Shared>,
    pub(super) watch: proc::ExitWatch,
    pub(super) children: BTreeMap<u64, Child>,
    pub(super) next_child: u64,
    pub(super) conns: BTreeMap<u64, Conn>,
    pub(super) next_conn: u64,
    pub(super) host_stop_waiters: Vec<mpsc::Sender<()>>,
    pub(super) stopping: Option<Stopping>,
    /// Groups of exited agents waiting for their KILL.
    pub(super) sweeps: Vec<Sweep>,
    /// Frozen for a handoff: no I/O at all until thawed (step 4).
    pub(super) frozen: bool,
    /// Failed accepts, and until when the listener is left out of the poll after one (#840 item 3).
    pub(super) accept_errors: AcceptErrors,
    pub(super) accept_paused_until: Option<Instant>,
    #[cfg(test)]
    pub(super) hold_next_poll: bool,
}

impl Reactor {
    pub(super) fn new(listener: UnixListener, wake: OwnedFd, shared: Arc<Shared>) -> io::Result<Self> {
        Ok(Reactor {
            listener,
            wake,
            shared,
            watch: proc::ExitWatch::new()?,
            children: BTreeMap::new(),
            next_child: 1,
            conns: BTreeMap::new(),
            next_conn: 1,
            host_stop_waiters: Vec::new(),
            stopping: None,
            sweeps: Vec::new(),
            frozen: false,
            accept_errors: AcceptErrors::new(log),
            accept_paused_until: None,
            #[cfg(test)]
            hold_next_poll: false,
        })
    }

    /// Runs the reactor on a thread of its own, the only one that touches its descriptors.
    pub(super) fn start(self) -> io::Result<()> {
        thread::Builder::new().name("keeper-children".into()).spawn(move || self.run()).map(|_| ())
    }

    pub(super) fn run(mut self) {
        loop {
            if self.frozen {
                // Only the command queue is listened to: a thaw, a reap, or nothing until the
                // process exits after a committed handoff.
                let mut p = libc::pollfd { fd: self.wake.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                // SAFETY: one valid pollfd.
                unsafe { libc::poll(&mut p, 1, 1000) };
                self.take_commands();
                continue;
            }
            #[cfg(test)]
            if std::mem::take(&mut self.hold_next_poll) {
                self.until_command_and_output();
            }
            let timeout = self.poll_timeout();
            let (mut fds, toks) = self.poll_set();
            // SAFETY: fds is a valid array of fds.len() pollfd entries.
            let rc = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
            if rc < 0 {
                let e = io::Error::last_os_error();
                if e.kind() != io::ErrorKind::Interrupted {
                    log(&format!("poll failed: {e}"));
                    thread::sleep(Duration::from_millis(50));
                }
                continue;
            }
            for (i, p) in fds.iter().enumerate() {
                if p.revents == 0 {
                    continue;
                }
                match toks[i] {
                    Tok::Listener => self.accept(),
                    Tok::Wake => self.take_commands(),
                    Tok::Exit => {}
                    Tok::Out(n) => self.read_child(n, Which::Out),
                    Tok::Err(n) => self.read_child(n, Which::Err),
                    Tok::In(n) => self.write_child(n),
                    Tok::Conn(c) => self.read_conn(c),
                }
                /*
                 * A freeze taken from the queue just now ends the pass here (#368). The wake pipe
                 * comes before the children and connections in the poll set, so without this the
                 * rest of the pass went on after the snapshot: a child's stdout ready in the same
                 * poll was read into a buffer the snapshot no longer covered, stranded in a keeper
                 * about to exit (the next keeper reads the pipe from after it: lines lost), and
                 * `pump` could send a reader or a control connection bytes the snapshot still held
                 * as unsent (the next keeper sends them again: lines or exit events doubled).
                 * Measured under load on macOS: 3 of 200 runs of
                 * `output_held_for_no_reader_reaches_the_next_keepers_reader` lost one line.
                 * What is left of the pass is level-triggered: it is still ready for the next
                 * keeper, or for this one after a thaw.
                 */
                if self.frozen {
                    break;
                }
            }
            if self.frozen {
                continue;
            }
            self.collect_exits();
            self.pump();
            self.housekeeping();
        }
    }

    /// Tests only (`Cmd::HoldNextPoll`): waits until the wake pipe and every open child stdout are
    /// readable, without reading any of them.
    #[cfg(test)]
    pub(super) fn until_command_and_output(&self) {
        let mut fds = vec![self.wake.as_raw_fd()];
        fds.extend(self.children.values().filter_map(|c| c.out_fd.as_ref().map(|f| f.as_raw_fd())));
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            let ready = fds.iter().all(|&fd| {
                let mut p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
                // SAFETY: one valid pollfd.
                let n = unsafe { libc::poll(&mut p, 1, 0) };
                n == 1
            });
            if ready {
                return;
            }
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// How long the next `poll` may wait: briefly while something is due soon, else a second. A
    /// pause after a failed accept that has run out is over here, whether or not a connection came
    /// meanwhile (macOS drops the one that failed, so none may come), so it does not keep the
    /// reactor waking ten times a second.
    pub(super) fn poll_timeout(&mut self) -> i32 {
        if self.accept_paused_until.is_some_and(|t| Instant::now() >= t) {
            self.accept_paused_until = None;
        }
        let quick = self.stopping.is_some()
            || !self.host_stop_waiters.is_empty()
            || self.watch.polling()
            || !self.sweeps.is_empty()
            || self.accept_paused_until.is_some();
        if quick {
            100
        } else {
            1000
        }
    }

    pub(super) fn poll_set(&self) -> (Vec<libc::pollfd>, Vec<Tok>) {
        let mut fds = Vec::new();
        let mut toks = Vec::new();
        let mut add = |fd: RawFd, events: libc::c_short, t: Tok| {
            fds.push(libc::pollfd { fd, events, revents: 0 });
            toks.push(t);
        };
        // Left out for a moment after a failed accept, which a waiting connection would otherwise
        // bring straight back (#840 item 3).
        if self.accept_paused_until.is_none_or(|t| Instant::now() >= t) {
            add(self.listener.as_raw_fd(), libc::POLLIN, Tok::Listener);
        }
        add(self.wake.as_raw_fd(), libc::POLLIN, Tok::Wake);
        for fd in self.watch.fds() {
            add(fd, libc::POLLIN, Tok::Exit);
        }
        for (&n, c) in &self.children {
            // Only streams with room are polled: a full agent stdout is left to fill its pipe, and
            // a descriptor polled for nothing would spin on POLLHUP.
            if let Some(fd) = &c.out_fd {
                if c.out.wants_input() {
                    add(fd.as_raw_fd(), libc::POLLIN, Tok::Out(n));
                }
            }
            if let Some(fd) = &c.err_fd {
                add(fd.as_raw_fd(), libc::POLLIN, Tok::Err(n));
            }
            if let Some(fd) = c.in_fd() {
                if !c.inbuf.is_empty() {
                    add(fd, libc::POLLOUT, Tok::In(n));
                }
            }
        }
        for (&id, conn) in &self.conns {
            let mut ev: libc::c_short = 0;
            let mut want_out = !conn.wbuf.is_empty();
            match conn.role {
                Role::Attach { child, which, detaching } => {
                    if let Some(c) = self.children.get(&child) {
                        let room = c.inbuf.len() < IN_CAP && conn.rbuf.len() < IN_CAP;
                        if room {
                            ev |= libc::POLLIN;
                        }
                        if !c.buf_ref(which).sendable(detaching).is_empty() {
                            want_out = true;
                        }
                    }
                }
                _ => ev |= libc::POLLIN,
            }
            if want_out {
                ev |= libc::POLLOUT;
            }
            add(conn.stream.as_raw_fd(), ev, Tok::Conn(id));
        }
        (fds, toks)
    }

    pub(super) fn take_commands(&mut self) {
        let mut b = [0u8; 64];
        while matches!(proc::read_fd(self.wake.as_raw_fd(), &mut b), Ok(n) if n > 0) {}
        let cmds = match self.shared.cmds.lock() {
            Ok(mut q) => std::mem::take(&mut *q),
            Err(_) => return,
        };
        for cmd in cmds {
            match cmd {
                Cmd::AskHostStop(done) => {
                    let any = self.tell_hosts(&json!({ "event": "stop" }));
                    log(if any { "asked the host to stop its children" } else { "no host connected to stop its children" });
                    self.host_stop_waiters.push(done);
                }
                Cmd::Freeze(reply) => {
                    let r = if self.frozen { Err("already frozen".to_string()) } else { self.freeze() };
                    let _ = reply.send(r);
                }
                Cmd::Thaw => {
                    if self.frozen {
                        self.frozen = false;
                        log("thawed: the handoff was rolled back");
                    }
                }
                #[cfg(test)]
                Cmd::HoldNextPoll(done) => {
                    self.hold_next_poll = true;
                    let _ = done.send(());
                }
                Cmd::Reap(reply) => {
                    let mut reaped = Vec::new();
                    for c in self.children.values_mut().filter(|c| c.exit.is_none()) {
                        if let Some(st) = proc::try_reap(c.pid) {
                            c.exit = Some(st);
                            c.exited_at = Some(Instant::now());
                            reaped.push((c.pid, st));
                        }
                    }
                    let _ = reply.send(reaped);
                }
                Cmd::StopAll { grace, done } => match &mut self.stopping {
                    Some(s) => s.done.push(done),
                    None => {
                        let live = self.children.values().filter(|c| c.exit.is_none()).count();
                        if live > 0 {
                            log(&format!("stopping {live} children still running"));
                        }
                        for c in self.children.values_mut().filter(|c| c.exit.is_none() && c.kind == Kind::Pipes) {
                            // EOF first: codex removes its thread lock on stdin EOF but not on TERM (#57).
                            c.inbuf.clear();
                            c.stdin = None;
                        }
                        let sessions: Vec<i32> = self.children.values().filter(|c| c.kind == Kind::Pty).map(|c| c.pid).collect();
                        self.signal_sessions(&sessions, libc::SIGHUP);
                        self.stopping = Some(Stopping { phase: 0, deadline: Instant::now() + grace, done: vec![done], sessions });
                    }
                },
            }
        }
    }

    pub(super) fn accept(&mut self) {
        self.accept_paused_until = None;
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    self.accept_errors.accepted();
                    if !accept::from_this_user(&stream, log) {
                        continue;
                    }
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    let id = self.next_conn;
                    self.next_conn += 1;
                    self.conns.insert(id, Conn { stream, role: Role::Hello, rbuf: Vec::new(), wbuf: Vec::new() });
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return,
                Err(e) => {
                    let pause = self.accept_errors.failed(&e);
                    if !pause.is_zero() {
                        self.accept_paused_until = Some(Instant::now() + pause);
                    }
                    return;
                }
            }
        }
    }

    pub(super) fn read_child(&mut self, n: u64, which: Which) {
        let Some(c) = self.children.get_mut(&n) else { return };
        let Some(fd) = c.out_fd(which) else { return };
        let mut tmp = vec![0u8; 64 * 1024];
        let mut eof = false;
        // Bounded per wakeup so one chatty child cannot starve the others.
        for _ in 0..16 {
            if !c.buf(which).wants_input() {
                break;
            }
            match proc::read_output(fd, &mut tmp) {
                proc::Output::Bytes(k) => c.buf(which).push(&tmp[..k]),
                proc::Output::Again => break,
                proc::Output::Interrupted => continue,
                // End of file, EIO from a pty master whose slave side is all closed, or any other
                // error: the same end.
                proc::Output::End => {
                    eof = true;
                    break;
                }
            }
        }
        if eof {
            c.end_stream(which);
        }
    }

    pub(super) fn write_child(&mut self, n: u64) {
        let Some(c) = self.children.get_mut(&n) else { return };
        write_inbuf(c);
    }

    pub(super) fn read_conn(&mut self, id: u64) {
        let Some(conn) = self.conns.get_mut(&id) else { return };
        let mut tmp = vec![0u8; 64 * 1024];
        let mut eof = false;
        let mut lost = false;
        for _ in 0..16 {
            match conn.stream.read(&mut tmp) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(k) => {
                    conn.rbuf.extend_from_slice(&tmp[..k]);
                    if conn.rbuf.len() >= IN_CAP {
                        break;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    lost = true;
                    break;
                }
            }
        }
        if lost {
            return self.drop_conn(id, Flush::Lost);
        }
        self.process_input(id);
        // What a burst left behind once it was taken: up to IN_CAP for an attach, LINE_CAP for a
        // control line (#392).
        if let Some(conn) = self.conns.get_mut(&id) {
            buffer::give_back(&mut conn.rbuf);
        }
        if eof {
            match self.conns.get_mut(&id).map(|c| &mut c.role) {
                // The host half-closed: it is detaching. Send what it is owed, then close.
                Some(Role::Attach { detaching, .. }) => *detaching = true,
                Some(_) => self.drop_conn(id, Flush::Close),
                None => {}
            }
        }
    }

    pub(super) fn drop_conn(&mut self, id: u64, how: Flush) {
        let Some(conn) = self.conns.remove(&id) else { return };
        if how == Flush::Close {
            let _ = conn.stream.shutdown(Shutdown::Write);
        }
        if let Role::Attach { child, which, .. } = conn.role {
            if let Some(c) = self.children.get_mut(&child) {
                if *c.reader(which) == Some(id) {
                    *c.reader(which) = None;
                    if how == Flush::Lost {
                        c.buf(which).reader_lost();
                    }
                }
            }
        }
    }

    /// Queues an event for every control connection (every host). Returns whether there was one.
    pub(super) fn tell_hosts(&mut self, event: &Value) -> bool {
        let line = json_line(event);
        let mut any = false;
        for conn in self.conns.values_mut().filter(|c| matches!(c.role, Role::Control)) {
            conn.wbuf.extend_from_slice(&line);
            any = true;
        }
        any
    }

    /// Ends a connection at once, both ways: a reader replaced by a new attach, or the reader of a
    /// child that is released.
    pub(super) fn close_conn(&mut self, id: u64) {
        if let Some(conn) = self.conns.remove(&id) {
            let _ = conn.stream.shutdown(Shutdown::Both);
        }
    }

    /// Moves every byte that can move: into children's stdin, out to readers and control
    /// connections.
    pub(super) fn pump(&mut self) {
        for c in self.children.values_mut() {
            write_inbuf(c);
        }
        let ids: Vec<u64> = self.conns.keys().copied().collect();
        for id in ids {
            let r = self.flush_conn(id);
            if r != Flush::Keep {
                self.drop_conn(id, r);
            }
        }
    }

    pub(super) fn flush_conn(&mut self, id: u64) -> Flush {
        let Some(conn) = self.conns.get_mut(&id) else { return Flush::Keep };
        let flushed = match flush_raw(&mut conn.stream, &mut conn.wbuf) {
            Ok(all) => all,
            Err(_) => return Flush::Lost,
        };
        buffer::give_back(&mut conn.wbuf);
        /*
         * The cap is checked whether or not the socket took everything (#392). Checked only after a
         * flush that emptied the queue, it could never fire: a host or client that stops reading is
         * exactly the one whose flush never completes, and its replies and exit events queued without
         * bound.
         */
        if !matches!(conn.role, Role::Attach { .. }) && conn.wbuf.len() > CONTROL_OUT_CAP {
            // Never silent: a host whose control connection goes sees every child it holds exit
            // with SIGHUP and cannot spawn until it restarts.
            let role = if matches!(conn.role, Role::Control) { "control" } else { "hello" };
            log(&format!(
                "dropped {role} connection {id}: {} bytes queued past the {CONTROL_OUT_CAP}-byte cap, its peer is not reading",
                conn.wbuf.len()
            ));
            return Flush::Lost;
        }
        if !flushed {
            return Flush::Keep;
        }
        let Role::Attach { child, which, detaching } = conn.role else { return Flush::Keep };
        let Some(c) = self.children.get_mut(&child) else { return Flush::Close };
        if *c.reader(which) != Some(id) {
            return Flush::Close;
        }
        let b = c.buf(which);
        loop {
            let chunk = b.sendable(detaching);
            if chunk.is_empty() {
                break;
            }
            let len = chunk.len();
            match conn.stream.write(chunk) {
                Ok(0) => return Flush::Lost,
                Ok(k) => {
                    b.sent(k);
                    if k < len {
                        return Flush::Keep;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Flush::Keep,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Flush::Lost,
            }
        }
        if (detaching && b.at_boundary()) || b.drained() {
            return Flush::Close;
        }
        Flush::Keep
    }
}

/// Writes as much of `wbuf` as the socket takes. `Ok(true)`: all of it.
pub(super) fn flush_raw(stream: &mut UnixStream, wbuf: &mut Vec<u8>) -> io::Result<bool> {
    while !wbuf.is_empty() {
        match stream.write(wbuf) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(k) => {
                wbuf.drain(..k);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}
