//! The child table handed from one reactor to another, in one process: the same descriptors and
//! the same snapshot a real handoff sends, minus the process boundary (which
//! `scripts/keeper-handoff-integration.mjs` covers with two real keepers).

use super::*;
use std::io::{Read, Write};

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(name: &str) -> Dir {
    // Short: a unix socket path must fit in 104 bytes.
    let d = PathBuf::from(format!("/tmp/cch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Dir(d)
}

fn send(s: &mut UnixStream, v: &Value) {
    let mut l = serde_json::to_vec(v).unwrap();
    l.push(b'\n');
    s.write_all(&l).unwrap();
}

/// One line, read a byte at a time so nothing after it is swallowed.
fn read_line(s: &mut UnixStream) -> Value {
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    loop {
        s.read_exact(&mut b).unwrap();
        if b[0] == b'\n' {
            break;
        }
        line.push(b[0]);
    }
    serde_json::from_slice(&line).unwrap()
}

fn connect(d: &Path) -> UnixStream {
    let s = UnixStream::connect(children::socket_path(d)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
    s
}

/// A child counting to `n` on stdout, one line every few milliseconds, held by `c`; returns the
/// control connection and an attach stream on its stdout.
fn counting_child(d: &Path, n: u32) -> (UnixStream, UnixStream) {
    let mut ctl = connect(d);
    send(&mut ctl, &json!({ "op": "hello", "protocol": 1 }));
    assert_eq!(read_line(&mut ctl)["ok"], true);
    let script = format!("i=0; while [ $i -lt {n} ]; do echo line$i; i=$((i+1)); sleep 0.004; done");
    send(
        &mut ctl,
        &json!({ "rid": 1, "op": "spawn", "kind": "pipes", "cmd": "/bin/sh", "args": ["-c", script], "cwd": "/tmp",
                 "env": { "PATH": "/usr/bin:/bin" }, "tag": { "kind": "test" } }),
    );
    let spawned = read_line(&mut ctl);
    assert_eq!(spawned["ok"], true, "{spawned}");
    let id = spawned["child"]["id"].as_str().unwrap().to_string();
    let mut out = connect(d);
    send(&mut out, &json!({ "op": "attach", "protocol": 1, "id": id, "stream": "out" }));
    assert_eq!(read_line(&mut out)["ok"], true);
    (ctl, out)
}

fn read_until(s: &mut UnixStream, got: &mut Vec<u8>, needle: &str) {
    let mut b = [0u8; 4096];
    while !String::from_utf8_lossy(got).contains(needle) {
        match s.read(&mut b) {
            Ok(0) => panic!("stream ended before {needle:?}"),
            Ok(n) => got.extend_from_slice(&b[..n]),
            Err(e) => panic!("no {needle:?} ({e}); got {:?}", String::from_utf8_lossy(got).len()),
        }
    }
}

/// Every line from 0 to n-1 exactly once, in order.
fn exactly_once(got: &[u8], n: u32) {
    let text = String::from_utf8_lossy(got);
    let lines: Vec<&str> = text.lines().collect();
    let want: Vec<String> = (0..n).map(|i| format!("line{i}")).collect();
    assert_eq!(lines.len(), want.len(), "lost or doubled lines across the handoff");
    for (a, b) in lines.iter().zip(&want) {
        assert_eq!(a, b);
    }
}

/// The handoff's central promise for agents: the stream a host reads goes on, on the same socket,
/// served by the next keeper, with no line lost and none sent twice; and the host's control
/// connection keeps working.
#[test]
fn a_child_table_handed_over_carries_on_with_no_line_lost_or_doubled() {
    let d = temp_dir("table");
    let a = Children::start(&d.0).unwrap();
    let (mut ctl, mut out) = counting_child(&d.0, 300);
    let mut got = Vec::new();
    read_until(&mut out, &mut got, "line40\n");

    let (state, pack) = a.freeze(Duration::from_secs(5)).unwrap().unwrap();
    // While frozen the child keeps writing into its pipe and nobody reads it
    std::thread::sleep(Duration::from_millis(150));
    let mut u = Unpack::new(pack.fds, pack.blobs);
    let b = Children::prepare(&d.0, &state, &mut u.shifted((0, 0))).unwrap().start(&[]).unwrap();

    read_until(&mut out, &mut got, "line299\n");
    exactly_once(&got, 300);
    send(&mut ctl, &json!({ "rid": 2, "op": "list" }));
    let mut list = read_line(&mut ctl);
    while list.get("event").is_some() {
        list = read_line(&mut ctl);
    }
    assert_eq!(list["rid"], 2, "the same control connection, answered by the next keeper");
    assert_eq!(list["children"].as_array().map(|a| a.len()), Some(1));
    b.stop_all(Duration::from_millis(200));
}

/// Output the keeper holds while no host is reading (between hosts) and output still in the
/// child's pipe both reach the next host through the next keeper. The outgoing keeper must not go
/// on reading after the freeze: what it read then would be stranded in a process about to exit.
#[test]
fn output_held_for_no_reader_reaches_the_next_keepers_reader() {
    let d = temp_dir("unread");
    let a = Children::start(&d.0).unwrap();
    let (_ctl, mut out) = counting_child(&d.0, 300);
    let mut got = Vec::new();
    read_until(&mut out, &mut got, "line40\n");
    // The host detaches (half-close): it is sent the rest of its line, then the stream ends
    out.shutdown(std::net::Shutdown::Write).unwrap();
    out.read_to_end(&mut got).unwrap();
    // Unread output piles up in the keeper while no host reads it
    std::thread::sleep(Duration::from_millis(200));

    let (state, pack) = a.freeze(Duration::from_secs(5)).unwrap().unwrap();
    std::thread::sleep(Duration::from_millis(150));
    let mut u = Unpack::new(pack.fds, pack.blobs);
    let b = Children::prepare(&d.0, &state, &mut u.shifted((0, 0))).unwrap().start(&[]).unwrap();
    // The outgoing keeper is frozen, not gone, as between the commit and its exit
    std::thread::sleep(Duration::from_millis(300));

    let id = state["children"][0]["n"].as_u64().map(|n| format!("c{n}")).unwrap();
    let mut again = connect(&d.0);
    send(&mut again, &json!({ "op": "attach", "protocol": 1, "id": id, "stream": "out" }));
    assert_eq!(read_line(&mut again)["ok"], true);
    read_until(&mut again, &mut got, "line299\n");
    exactly_once(&got, 300);
    b.stop_all(Duration::from_millis(200));
}

/// A rolled-back handoff: the frozen reactor carries on where it stopped, nothing lost.
#[test]
fn a_thawed_child_table_carries_on_as_if_nothing_happened() {
    let d = temp_dir("thaw");
    let a = Children::start(&d.0).unwrap();
    let (_ctl, mut out) = counting_child(&d.0, 200);
    let mut got = Vec::new();
    read_until(&mut out, &mut got, "line20\n");
    let frozen = a.freeze(Duration::from_secs(5)).unwrap().unwrap();
    drop(frozen);
    std::thread::sleep(Duration::from_millis(100));
    a.thaw();
    read_until(&mut out, &mut got, "line199\n");
    exactly_once(&got, 200);
    a.stop_all(Duration::from_millis(200));
}

#[test]
fn the_reaped_list_reads_back_as_written() {
    let v = json!([[42, 7, null], [43, null, 15]]);
    assert_eq!(
        parse_reaped(Some(&v)),
        vec![(42, ExitStatus { code: Some(7), signal: None }), (43, ExitStatus { code: None, signal: Some(15) })]
    );
    assert!(parse_reaped(None).is_empty());
}
