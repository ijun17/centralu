//! The child service against real processes and a real socket, the way a host uses it.

use super::*;
use std::io::{BufRead, BufReader};

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(name: &str) -> Dir {
    // Short: a unix socket path must fit in 104 bytes.
    let d = PathBuf::from(format!("/tmp/cck-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    Dir(d)
}

/// A control connection, as a host holds one.
struct Control {
    w: UnixStream,
    r: BufReader<UnixStream>,
    rid: u64,
    events: Vec<Value>,
}

impl Control {
    fn open(data: &Path) -> Control {
        let s = UnixStream::connect(socket_path(data)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut c = Control { r: BufReader::new(s.try_clone().unwrap()), w: s, rid: 0, events: Vec::new() };
        c.send(&json!({ "op": "hello", "protocol": CHILDREN_PROTOCOL }));
        let hello = c.line();
        assert_eq!(hello["ok"], true, "{hello}");
        c
    }
    fn send(&mut self, v: &Value) {
        self.w.write_all(&event_line(v)).unwrap();
    }
    fn line(&mut self) -> Value {
        let mut l = String::new();
        self.r.read_line(&mut l).expect("a line from the keeper");
        serde_json::from_str(&l).unwrap_or_else(|e| panic!("not JSON ({e}): {l:?}"))
    }
    fn req(&mut self, mut v: Value) -> Value {
        self.rid += 1;
        v["rid"] = json!(self.rid);
        self.send(&v);
        loop {
            let l = self.line();
            if l.get("event").is_some() {
                self.events.push(l);
                continue;
            }
            assert_eq!(l["rid"], json!(self.rid));
            return l;
        }
    }
    fn spawn(&mut self, kind: &str, script: &str) -> (String, i32) {
        let r = self.req(json!({
            "op": "spawn", "kind": kind, "cmd": "/bin/sh", "args": ["-c", script], "cwd": "/tmp",
            "env": { "PATH": "/usr/bin:/bin", "TERM": "xterm" }, "cols": 80, "rows": 24,
            "tag": { "kind": "test", "key": script },
        }));
        assert_eq!(r["ok"], true, "{r}");
        (r["child"]["id"].as_str().unwrap().to_string(), r["child"]["pid"].as_i64().unwrap() as i32)
    }
    fn wait_event(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(i) = self.events.iter().position(&pred) {
            return self.events.remove(i);
        }
        loop {
            let l = self.line();
            if pred(&l) {
                return l;
            }
        }
    }
}

fn attach(data: &Path, id: &str, stream: &str) -> (UnixStream, Value) {
    let mut s = UnixStream::connect(socket_path(data)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(&event_line(&json!({ "op": "attach", "protocol": CHILDREN_PROTOCOL, "id": id, "stream": stream })))
        .unwrap();
    // The answer line, read one byte at a time so no raw output is swallowed with it.
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    loop {
        s.read_exact(&mut b).unwrap();
        if b[0] == b'\n' {
            break;
        }
        line.push(b[0]);
    }
    (s, serde_json::from_slice(&line).unwrap())
}

fn read_until(s: &mut UnixStream, needle: &str) -> String {
    let mut got = Vec::new();
    let mut b = [0u8; 4096];
    while !String::from_utf8_lossy(&got).contains(needle) {
        match s.read(&mut b) {
            Ok(0) => panic!("stream ended before {needle:?}: {:?}", String::from_utf8_lossy(&got)),
            Ok(n) => got.extend_from_slice(&b[..n]),
            Err(e) => panic!("no {needle:?} ({e}): {:?}", String::from_utf8_lossy(&got)),
        }
    }
    String::from_utf8_lossy(&got).to_string()
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Gone and reaped: a zombie left behind would still answer `kill(pid, 0)`.
fn gone(pid: i32) -> bool {
    let end = Instant::now() + Duration::from_secs(3);
    while alive(pid) && Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
    !alive(pid)
}

#[test]
fn the_socket_is_private_to_this_user() {
    let d = temp_dir("mode");
    let _c = Children::start(&d.0).unwrap();
    let mode = fs::metadata(socket_path(&d.0)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

/// The point of step 2: a host going away — its connections closing — is not a stop.
#[test]
fn a_departing_host_does_not_end_the_child_and_the_next_host_gets_what_it_missed() {
    let d = temp_dir("leave");
    let keeper = Children::start(&d.0).unwrap();
    let mut host1 = Control::open(&d.0);
    let (id, pid) = host1.spawn("pipes", "echo first; read x; echo \"got $x\"; sleep 0.3; echo after; read y; echo \"bye $y\"");
    let (mut out1, _) = attach(&d.0, &id, "out");
    read_until(&mut out1, "first\n");
    out1.write_all(b"one\n").unwrap();
    read_until(&mut out1, "got one\n");
    // Host 1 vanishes: every connection drops without a word.
    drop(out1);
    drop(host1);
    thread::sleep(Duration::from_millis(600));
    assert!(alive(pid), "the child outlived its host");

    let mut host2 = Control::open(&d.0);
    let list = host2.req(json!({ "op": "list" }));
    assert_eq!(list["children"][0]["id"], json!(id));
    assert_eq!(list["children"][0]["tag"]["kind"], "test", "the host's tag comes back untouched");
    let (mut out2, _) = attach(&d.0, &id, "out");
    read_until(&mut out2, "after\n");
    out2.write_all(b"two\n").unwrap();
    read_until(&mut out2, "bye two\n");
    let ev = host2.wait_event(|e| e["event"] == "exit");
    assert_eq!(ev["code"], 0);
    drop(keeper);
}

/// A pty child cannot finish exiting while its output is unread (#280 1a), so the keeper drains
/// it with nobody attached.
#[test]
fn an_unwatched_pty_is_drained_so_its_child_can_exit() {
    let d = temp_dir("drain");
    let _keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    // Far more than a pty's kernel buffer, with nobody reading.
    let (id, _) = host.spawn("pty", "i=0; while [ $i -lt 4000 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; exit 3");
    let ev = host.wait_event(|e| e["event"] == "exit" && e["id"] == json!(id));
    assert_eq!(ev["code"], 3);
    // The screen survives for a host that attaches afterwards: the last lines, replayed.
    let (mut out, _) = attach(&d.0, &id, "out");
    read_until(&mut out, "line-3999-");
}

#[test]
fn a_pty_is_resized_through_the_keeper_and_a_new_reader_gets_the_screen_replayed() {
    let d = temp_dir("resize");
    let _keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    let (id, _) = host.spawn("pty", "stty size; read x; stty size; read y");
    let (mut a, _) = attach(&d.0, &id, "out");
    read_until(&mut a, "24 80");
    drop(a);
    let r = host.req(json!({ "op": "resize", "id": id, "cols": 132, "rows": 50 }));
    assert_eq!(r["ok"], true, "{r}");
    let (mut b, _) = attach(&d.0, &id, "out");
    read_until(&mut b, "24 80"); // replayed
    b.write_all(b"\n").unwrap();
    read_until(&mut b, "50 132");
    b.write_all(b"\n").unwrap();
}

/// Only an explicit request ends a child; it reports how it ended.
#[test]
fn a_signal_request_ends_the_child_and_its_exit_is_reported() {
    let d = temp_dir("signal");
    let _keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    let (id, pid) = host.spawn("pipes", "exec sleep 30");
    let r = host.req(json!({ "op": "signal", "id": id, "signal": "SIGTERM" }));
    assert_eq!(r["ok"], true);
    let ev = host.wait_event(|e| e["event"] == "exit");
    assert_eq!(ev["signal"], libc::SIGTERM);
    assert!(gone(pid));
    // Released, it is gone from the list; a running child cannot be released.
    let (id2, pid2) = host.spawn("pipes", "exec sleep 30");
    assert_eq!(host.req(json!({ "op": "release", "id": id2 }))["ok"], false);
    assert_eq!(host.req(json!({ "op": "release", "id": id }))["ok"], true);
    let list = host.req(json!({ "op": "list" }));
    assert_eq!(list["children"].as_array().unwrap().len(), 1);
    let _ = proc::signal(pid2, libc::SIGKILL, false);
}

/// codex removes its thread lock on stdin EOF (#57): `close_stdin` is how a host asks for that.
#[test]
fn close_stdin_gives_the_child_eof_after_what_was_written() {
    let d = temp_dir("eof");
    let _keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    let (id, _) = host.spawn("pipes", "cat; echo eof-seen");
    let (mut out, _) = attach(&d.0, &id, "out");
    out.write_all(b"hello\n").unwrap();
    read_until(&mut out, "hello\n");
    assert_eq!(host.req(json!({ "op": "close_stdin", "id": id }))["ok"], true);
    read_until(&mut out, "eof-seen\n");
    assert_eq!(host.wait_event(|e| e["event"] == "exit")["code"], 0);
}

/// A host writing half a request and then dying must not leave the agent a torn line.
#[test]
fn half_a_line_from_a_host_that_died_never_reaches_the_child() {
    let d = temp_dir("torn");
    let _keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    let (id, _) = host.spawn("pipes", "while read l; do echo \"[$l]\"; done");
    let (mut a, _) = attach(&d.0, &id, "out");
    a.write_all(b"whole\nhal").unwrap();
    read_until(&mut a, "[whole]\n");
    drop(a);
    thread::sleep(Duration::from_millis(200));
    let (mut b, _) = attach(&d.0, &id, "out");
    b.write_all(b"next\n").unwrap();
    let got = read_until(&mut b, "[next]\n");
    assert!(!got.contains("hal"), "{got:?}");
}

#[test]
fn stop_all_ends_pipes_and_ptys_the_host_left_running() {
    let d = temp_dir("stopall");
    let keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    // EOF ends the first; the pty ignores HUP and TERM, so only the KILL step ends it.
    let (_, p1) = host.spawn("pipes", "read x");
    let (_, p2) = host.spawn("pty", "trap '' HUP TERM; while :; do sleep 1; done");
    thread::sleep(Duration::from_millis(300));
    let t = Instant::now();
    keeper.stop_all(Duration::from_millis(300));
    assert!(gone(p1) && gone(p2), "both gone");
    assert!(t.elapsed() < Duration::from_secs(5));
    assert!(!socket_path(&d.0).exists(), "the socket goes with the stop");
}

#[test]
fn asking_the_host_to_stop_waits_for_it_to_hang_up() {
    let d = temp_dir("askstop");
    let keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    let k = keeper.clone();
    let waiter = thread::spawn(move || k.ask_host_to_stop(Duration::from_secs(5)));
    let ev = host.wait_event(|e| e.get("event").is_some());
    assert_eq!(ev["event"], "stop");
    thread::sleep(Duration::from_millis(200));
    assert!(!waiter.is_finished(), "still waiting while the host is connected");
    drop(host);
    assert!(waiter.join().unwrap(), "done once the host hung up");
    // With no host at all there is nothing to wait for.
    assert!(keeper.ask_host_to_stop(Duration::from_secs(5)));
}

#[test]
fn a_new_attach_replaces_the_old_reader() {
    let d = temp_dir("replace");
    let _keeper = Children::start(&d.0).unwrap();
    let mut host = Control::open(&d.0);
    let (id, _) = host.spawn("pipes", "read x; echo \"$x\"; read y");
    let (mut old, _) = attach(&d.0, &id, "out");
    let (mut new, _) = attach(&d.0, &id, "out");
    let mut b = [0u8; 16];
    assert_eq!(old.read(&mut b).unwrap_or(0), 0, "the replaced reader is closed");
    new.write_all(b"ping\n").unwrap();
    read_until(&mut new, "ping\n");
    new.write_all(b"\n").unwrap();
}
