//! The child table as one keeper hands it to the next (#280 step 4): frozen, described, rebuilt.

use super::*;

/// The child table as one keeper hands it to the next (#280 step 4). Descriptors and buffers are
/// indices into the handoff message (`../handoff/pack.rs`).
#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ReactorState {
    pub(super) listener: usize,
    pub(super) next_child: u64,
    pub(super) next_conn: u64,
    pub(super) children: Vec<ChildState>,
    pub(super) conns: Vec<ConnState>,
    /// Required since #461: a table from a keeper older than #435, which had none, is refused, and
    /// the handoff rolls back. Ignored by a keeper that old: a sweep handed to it is lost, which is
    /// no worse than that keeper never sweeping.
    pub(super) sweeps: Vec<SweepState>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct SweepState {
    pub(super) pgid: i32,
    pub(super) due_in_ms: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ChildState {
    pub(super) n: u64,
    pub(super) kind: Kind,
    pub(super) pid: i32,
    pub(super) cmd: String,
    pub(super) args: Vec<String>,
    pub(super) cwd: String,
    pub(super) started_ms: u64,
    pub(super) tag: Value,
    pub(super) cols: u16,
    pub(super) rows: u16,
    pub(super) stdin: Option<usize>,
    pub(super) out_fd: Option<usize>,
    pub(super) err_fd: Option<usize>,
    pub(super) out: BufState,
    pub(super) out_data: usize,
    pub(super) err: BufState,
    pub(super) err_data: usize,
    pub(super) out_reader: Option<u64>,
    pub(super) err_reader: Option<u64>,
    pub(super) inbuf: usize,
    pub(super) close_stdin: bool,
    pub(super) exit: Option<ExitStatus>,
    /// How long ago it exited, so the oldest exited children still go first.
    pub(super) exited_ms_ago: Option<u64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ConnState {
    pub(super) id: u64,
    pub(super) fd: usize,
    pub(super) role: RoleState,
    pub(super) rbuf: usize,
    pub(super) wbuf: usize,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub(super) enum RoleState {
    Hello,
    Control,
    Attach { child: u64, which: Which, detaching: bool },
}

impl From<&Role> for RoleState {
    fn from(r: &Role) -> Self {
        match *r {
            Role::Hello => RoleState::Hello,
            Role::Control => RoleState::Control,
            Role::Attach { child, which, detaching } => RoleState::Attach { child, which, detaching },
        }
    }
}

impl From<RoleState> for Role {
    fn from(r: RoleState) -> Self {
        match r {
            RoleState::Hello => Role::Hello,
            RoleState::Control => Role::Control,
            RoleState::Attach { child, which, detaching } => Role::Attach { child, which, detaching },
        }
    }
}

impl Reactor {
    /// Describes the whole table and stops all I/O (step 4). Called on the reactor thread, from the
    /// command queue, so no request is half handled and no buffer half updated; `run` then ends the
    /// pass without touching anything more (#368).
    pub(super) fn freeze(&mut self) -> Result<(Value, Pack), String> {
        if self.stopping.is_some() || !self.host_stop_waiters.is_empty() {
            return Err("the child service is stopping".into());
        }
        // Whatever has exited is reaped now, while this keeper is still the parent; the snapshot
        // then carries the status.
        self.collect_exits();
        let mut pack = Pack::default();
        let e = |e: io::Error| e.to_string();
        let listener = pack.fd(&self.listener).map_err(e)?;
        let now = Instant::now();
        let mut children = Vec::new();
        for (&n, c) in &self.children {
            let (out, out_bytes) = c.out.save();
            let (err, err_bytes) = c.err.save();
            children.push(ChildState {
                n,
                kind: c.kind,
                pid: c.pid,
                cmd: c.cmd.clone(),
                args: c.args.clone(),
                cwd: c.cwd.clone(),
                started_ms: c.started_ms,
                tag: c.tag.clone(),
                cols: c.cols,
                rows: c.rows,
                stdin: c.stdin.as_ref().map(|f| pack.fd(f)).transpose().map_err(e)?,
                out_fd: c.out_fd.as_ref().map(|f| pack.fd(f)).transpose().map_err(e)?,
                err_fd: c.err_fd.as_ref().map(|f| pack.fd(f)).transpose().map_err(e)?,
                out,
                out_data: pack.blob(out_bytes),
                err,
                err_data: pack.blob(err_bytes),
                out_reader: c.out_reader,
                err_reader: c.err_reader,
                inbuf: pack.blob(c.inbuf.clone()),
                close_stdin: c.close_stdin,
                exit: c.exit,
                exited_ms_ago: c.exited_at.map(|t| now.duration_since(t).as_millis() as u64),
            });
        }
        let mut conns = Vec::new();
        for (&id, conn) in &self.conns {
            conns.push(ConnState {
                id,
                fd: pack.fd(&conn.stream).map_err(e)?,
                role: RoleState::from(&conn.role),
                rbuf: pack.blob(conn.rbuf.clone()),
                wbuf: pack.blob(conn.wbuf.clone()),
            });
        }
        let sweeps = self
            .sweeps
            .iter()
            .map(|s| SweepState { pgid: s.pgid, due_in_ms: s.due.saturating_duration_since(now).as_millis() as u64 })
            .collect();
        let st = ReactorState { listener, next_child: self.next_child, next_conn: self.next_conn, children, conns, sweeps };
        let v = serde_json::to_value(&st).map_err(|e| e.to_string())?;
        self.frozen = true;
        log(&format!("frozen for a handoff ({} children, {} connections)", st.children.len(), st.conns.len()));
        Ok((v, pack))
    }

    /// Rebuilds a table another keeper froze. Exit watches are registered here (passive); every
    /// read and write waits for `run`.
    pub(super) fn restore(st: ReactorState, u: &mut Shifted, wake: OwnedFd, shared: Arc<Shared>) -> Result<Reactor, String> {
        let nb = |fd: &OwnedFd| proc::set_nonblocking(fd.as_raw_fd()).map_err(|e| e.to_string());
        let lfd = u.fd(st.listener)?;
        nb(&lfd)?;
        let listener = UnixListener::from(lfd);
        let mut r = Reactor::new(listener, wake, shared).map_err(|e| e.to_string())?;
        r.next_child = st.next_child;
        r.next_conn = st.next_conn;
        let now = Instant::now();
        r.sweeps = st.sweeps.iter().map(|s| Sweep { pgid: s.pgid, due: now + Duration::from_millis(s.due_in_ms) }).collect();
        for c in st.children {
            let mut take = |i: Option<usize>| -> Result<Option<OwnedFd>, String> {
                match i {
                    Some(i) => {
                        let fd = u.fd(i)?;
                        nb(&fd)?;
                        Ok(Some(fd))
                    }
                    None => Ok(None),
                }
            };
            let stdin = take(c.stdin)?;
            let out_fd = take(c.out_fd)?;
            let err_fd = take(c.err_fd)?;
            if c.exit.is_none() {
                r.watch.watch(c.pid);
            }
            let child = Child {
                kind: c.kind,
                pid: c.pid,
                cmd: c.cmd,
                args: c.args,
                cwd: c.cwd,
                started_ms: c.started_ms,
                tag: c.tag,
                cols: c.cols,
                rows: c.rows,
                stdin,
                out_fd,
                err_fd,
                out: OutBuf::restore(&c.out, u.blob(c.out_data)?),
                err: OutBuf::restore(&c.err, u.blob(c.err_data)?),
                out_reader: c.out_reader,
                err_reader: c.err_reader,
                inbuf: u.blob(c.inbuf)?,
                close_stdin: c.close_stdin,
                exit: c.exit,
                exited_at: c.exited_ms_ago.map(|ms| now.checked_sub(Duration::from_millis(ms)).unwrap_or(now)),
            };
            r.children.insert(c.n, child);
        }
        for c in st.conns {
            let fd = u.fd(c.fd)?;
            let stream = UnixStream::from(fd);
            stream.set_nonblocking(true).map_err(|e| e.to_string())?;
            r.conns.insert(c.id, Conn { stream, role: c.role.into(), rbuf: u.blob(c.rbuf)?, wbuf: u.blob(c.wbuf)? });
        }
        Ok(r)
    }
}
