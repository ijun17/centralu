//! What a connection asks for: the first line that says what it is, then a host's control requests.

use super::*;

/// A request's failure answer.
pub(super) fn fail(msg: String) -> Value {
    json!({ "ok": false, "error": msg })
}

impl Reactor {
    /// Acts on what a connection has sent so far.
    pub(super) fn process_input(&mut self, id: u64) {
        loop {
            let Some(conn) = self.conns.get_mut(&id) else { return };
            match conn.role {
                Role::Attach { child, which, .. } => {
                    let Some(c) = self.children.get_mut(&child) else { return };
                    attach_input(c, which, &mut conn.rbuf);
                    return;
                }
                Role::Hello | Role::Control => {
                    let Some(nl) = conn.rbuf.iter().position(|&b| b == b'\n') else {
                        if conn.rbuf.len() > LINE_CAP {
                            self.drop_conn(id, Flush::Close);
                        }
                        return;
                    };
                    let line: Vec<u8> = conn.rbuf.drain(..=nl).collect();
                    let req: Value = match serde_json::from_slice(&line) {
                        Ok(v) => v,
                        Err(e) => {
                            let r = json!({ "ok": false, "error": format!("not JSON: {e}") });
                            conn.wbuf.extend_from_slice(&json_line(&r));
                            continue;
                        }
                    };
                    let is_hello = matches!(conn.role, Role::Hello);
                    if is_hello {
                        self.handshake(id, &req);
                    } else {
                        let mut resp = self.request(&req);
                        if let Some(rid) = req.get("rid") {
                            resp["rid"] = rid.clone();
                        }
                        if let Some(conn) = self.conns.get_mut(&id) {
                            conn.wbuf.extend_from_slice(&json_line(&resp));
                        }
                    }
                }
            }
        }
    }

    pub(super) fn handshake(&mut self, id: u64, req: &Value) {
        let protocol = req.get("protocol").and_then(Value::as_u64).unwrap_or(0);
        let op = req.get("op").and_then(Value::as_str).unwrap_or("");
        let refuse = |me: &mut Self, msg: String| {
            if let Some(conn) = me.conns.get_mut(&id) {
                conn.wbuf.extend_from_slice(&json_line(&json!({ "ok": false, "error": msg })));
                let _ = flush_raw(&mut conn.stream, &mut conn.wbuf);
            }
            me.drop_conn(id, Flush::Close);
        };
        if protocol != CHILDREN_PROTOCOL as u64 {
            return refuse(self, format!("children protocol mismatch (keeper {CHILDREN_PROTOCOL}, host {protocol})"));
        }
        match op {
            "hello" => {
                if let Some(conn) = self.conns.get_mut(&id) {
                    conn.role = Role::Control;
                    let r = json!({ "ok": true, "protocol": CHILDREN_PROTOCOL, "keeperPid": std::process::id() });
                    conn.wbuf.extend_from_slice(&json_line(&r));
                }
            }
            "attach" => {
                let Some(n) = parse_child_id(req.get("id")) else {
                    return refuse(self, "attach needs an id".into());
                };
                let which = match req.get("stream").and_then(Value::as_str).unwrap_or("out") {
                    "out" => Which::Out,
                    "err" => Which::Err,
                    s => return refuse(self, format!("unknown stream {s:?}")),
                };
                let Some(c) = self.children.get_mut(&n) else {
                    return refuse(self, format!("no child {}", child_id(n)));
                };
                if which == Which::Err && c.kind == Kind::Pty {
                    return refuse(self, "a pty has no separate stderr".into());
                }
                let old = c.reader(which).replace(id);
                c.buf(which).attached();
                let info = c.info(n);
                if let Some(conn) = self.conns.get_mut(&id) {
                    conn.role = Role::Attach { child: n, which, detaching: false };
                    conn.wbuf.extend_from_slice(&json_line(&json!({ "ok": true, "child": info })));
                }
                // The previous reader, if it is still there, is a host that has been replaced.
                if let Some(old) = old.filter(|&o| o != id) {
                    self.close_conn(old);
                }
            }
            other => refuse(self, format!("unknown first op {other:?}")),
        }
    }

    /// The child a request names by `id`, or the answer saying why there is none.
    pub(super) fn named(&mut self, req: &Value, op: &str) -> Result<&mut Child, Value> {
        let Some(n) = parse_child_id(req.get("id")) else { return Err(fail(format!("{op} needs an id"))) };
        self.children.get_mut(&n).ok_or_else(|| fail(format!("no child {}", child_id(n))))
    }

    /// One control request. Every answer carries `ok`.
    pub(super) fn request(&mut self, req: &Value) -> Value {
        let op = req.get("op").and_then(Value::as_str).unwrap_or("");
        match op {
            "list" => {
                let list: Vec<Value> = self.children.iter().map(|(&n, c)| c.info(n)).collect();
                json!({ "ok": true, "children": list })
            }
            "spawn" => match self.spawn(req) {
                Ok(v) => json!({ "ok": true, "child": v }),
                Err(e) => fail(e),
            },
            "signal" => {
                let c = match self.named(req, op) {
                    Ok(c) => c,
                    Err(answer) => return answer,
                };
                let name = req.get("signal").and_then(Value::as_str).unwrap_or("SIGTERM");
                let Some(sig) = proc::signal_number(name) else { return fail(format!("signal {name:?} is not allowed")) };
                // An exited child's pid may already belong to someone else.
                if c.exit.is_some() {
                    return json!({ "ok": true, "exited": true });
                }
                let group = req.get("group").and_then(Value::as_bool).unwrap_or(false);
                match proc::signal(c.pid, sig, group) {
                    Ok(()) => json!({ "ok": true }),
                    Err(e) => fail(format!("signal failed: {e}")),
                }
            }
            "close_stdin" => {
                let c = match self.named(req, op) {
                    Ok(c) => c,
                    Err(answer) => return answer,
                };
                if c.kind != Kind::Pipes {
                    return fail("a pty has no stdin of its own to close".into());
                }
                c.close_stdin = true;
                if c.inbuf.is_empty() {
                    c.stdin = None;
                }
                json!({ "ok": true })
            }
            "resize" => {
                let c = match self.named(req, op) {
                    Ok(c) => c,
                    Err(answer) => return answer,
                };
                let cols = req.get("cols").and_then(Value::as_u64).unwrap_or(0).min(u16::MAX as u64) as u16;
                let rows = req.get("rows").and_then(Value::as_u64).unwrap_or(0).min(u16::MAX as u64) as u16;
                if c.kind != Kind::Pty || cols < 2 || rows < 2 {
                    return fail("resize needs a pty and a size of at least 2x2".into());
                }
                let Some(fd) = c.out_fd.as_ref().map(|f| f.as_raw_fd()) else { return json!({ "ok": true, "exited": true }) };
                match proc::resize(fd, cols, rows) {
                    Ok(()) => {
                        c.cols = cols;
                        c.rows = rows;
                        json!({ "ok": true })
                    }
                    Err(e) => fail(format!("resize failed: {e}")),
                }
            }
            "set_tag" => {
                let c = match self.named(req, op) {
                    Ok(c) => c,
                    Err(answer) => return answer,
                };
                c.tag = req.get("tag").cloned().unwrap_or(Value::Null);
                json!({ "ok": true })
            }
            "release" => {
                let Some(n) = parse_child_id(req.get("id")) else { return fail("release needs an id".into()) };
                match self.children.get(&n) {
                    None => json!({ "ok": true }),
                    Some(c) if c.exit.is_none() => fail("still running: signal it first".into()),
                    Some(_) => {
                        self.remove_child(n);
                        json!({ "ok": true })
                    }
                }
            }
            _ => fail(format!("unknown op {op:?}")),
        }
    }

    pub(super) fn spawn(&mut self, req: &Value) -> Result<Value, String> {
        let kind = match req.get("kind").and_then(Value::as_str) {
            Some("pipes") => Kind::Pipes,
            Some("pty") => Kind::Pty,
            other => return Err(format!("unknown kind {other:?}")),
        };
        let cmd = req.get("cmd").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("spawn needs a cmd")?;
        let args: Vec<String> = req
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let cwd = req.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("spawn needs a cwd")?;
        let env: HashMap<String, String> = req
            .get("env")
            .and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        let cols = req.get("cols").and_then(Value::as_u64).unwrap_or(80).clamp(2, u16::MAX as u64) as u16;
        let rows = req.get("rows").and_then(Value::as_u64).unwrap_or(24).clamp(2, u16::MAX as u64) as u16;
        let program = proc::resolve_program(cmd, &env);
        let s = match kind {
            Kind::Pipes => proc::spawn_pipes(&program, &args, cwd, &env),
            Kind::Pty => proc::spawn_pty(&program, &args, cwd, &env, cols, rows),
        }
        .map_err(|e| format!("could not start {cmd}: {e}"))?;
        let n = self.next_child;
        self.next_child += 1;
        self.watch.watch(s.pid);
        let started_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let mut err = OutBuf::new(Policy::Tail { cap: TAIL_CAP });
        if s.err.is_none() {
            err.eof = true;
        }
        let c = Child {
            kind,
            pid: s.pid,
            cmd: program,
            args,
            cwd: cwd.to_string(),
            started_ms,
            tag: req.get("tag").cloned().unwrap_or(Value::Null),
            cols,
            rows,
            stdin: s.stdin,
            out_fd: Some(s.out),
            err_fd: s.err,
            out: OutBuf::new(match kind {
                Kind::Pipes => Policy::Lines { cap: LINES_CAP },
                Kind::Pty => Policy::Ring { cap: RING_CAP },
            }),
            err,
            out_reader: None,
            err_reader: None,
            inbuf: Vec::new(),
            close_stdin: false,
            exit: None,
            exited_at: None,
        };
        log(&format!("{} started pid {} ({}) {}", child_id(n), c.pid, if kind == Kind::Pty { "pty" } else { "pipes" }, c.cmd));
        let info = c.info(n);
        self.children.insert(n, c);
        Ok(info)
    }

    pub(super) fn remove_child(&mut self, n: u64) {
        let Some(c) = self.children.remove(&n) else { return };
        for id in [c.out_reader, c.err_reader].into_iter().flatten() {
            self.close_conn(id);
        }
    }
}
