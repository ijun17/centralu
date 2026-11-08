//! The keeper handoff's own rules, in one process (`scripts/keeper-handoff-integration.mjs` covers two real keepers).

use super::*;

/// An incoming keeper that exits before it is ready: the rollback says how it exited, not the
/// read error the closed channel gave ("failed to fill whole buffer", #368).
#[test]
fn an_incoming_keeper_that_exits_is_reported_by_how_it_exited() {
    let eof = std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "failed to fill whole buffer");
    let mut killed = Command::new("/bin/sh").args(["-c", "kill -9 $$"]).spawn().unwrap();
    let why = silent(&mut killed, &eof, "finish taking over", "it finished taking over");
    assert!(why.contains("exited before it finished taking over") && why.contains("killed by signal 9 (SIGKILL)"), "{why}");
    assert!(!why.contains("fill whole buffer"), "{why}");

    let mut gave_up = Command::new("/bin/sh").args(["-c", &format!("exit {EXIT_ABORTED}")]).spawn().unwrap();
    let why = silent(&mut gave_up, &eof, "start", "it started");
    assert!(why.contains("exited before it started") && why.contains("gave the handoff up"), "{why}");
}

/// One that is still running but silent past the bound is reported as silent, without waiting.
#[test]
fn an_incoming_keeper_that_does_not_answer_is_reported_as_silent() {
    let timeout = std::io::Error::new(std::io::ErrorKind::WouldBlock, "Resource temporarily unavailable");
    let mut alive = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let why = silent(&mut alive, &timeout, "finish taking over", "it finished taking over");
    let _ = alive.kill();
    let _ = alive.wait();
    assert!(why.starts_with("the new keeper did not finish taking over:"), "{why}");
}

/**
 * #840 item 4: an incoming keeper whose channel closed after `ready` with no `commit` takes over
 * only once the outgoing keeper is gone. That keeper's channel closes as it exits, so it may still
 * be finishing its exit, and once ended it is a zombie until its parent reaps it: one `kill(pid, 0)`
 * read both as alive, and both keepers exited.
 */
#[test]
fn an_outgoing_keeper_that_is_a_zombie_or_still_exiting_counts_as_gone() {
    // A zombie: ended, not reaped by its parent (this test).
    let mut zombie = Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
    let pid = zombie.id();
    // SAFETY: info is a valid out-pointer; WNOWAIT leaves the child to be reaped below.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) }, 0);
    let zombie_gone = previous_keeper_gone(pid, Duration::from_millis(500));
    zombie.wait().unwrap();
    assert!(zombie_gone, "a zombie outgoing keeper counted as running");

    // Still exiting when the channel closed: gone a moment later.
    let mut exiting = Command::new("/bin/sh").args(["-c", "sleep 0.3"]).spawn().unwrap();
    let pid = exiting.id();
    let reaper = std::thread::spawn(move || exiting.wait());
    let exiting_gone = previous_keeper_gone(pid, Duration::from_secs(10));
    reaper.join().unwrap().unwrap();
    assert!(exiting_gone, "an outgoing keeper still exiting counted as running");

    // One that really runs on is still running at the bound.
    let mut running = Command::new("/bin/sh").args(["-c", "sleep 30"]).spawn().unwrap();
    let still = !previous_keeper_gone(running.id(), Duration::from_millis(200));
    let _ = running.kill();
    let _ = running.wait();
    assert!(still, "a running outgoing keeper counted as gone");
}

/// The snapshot a keeper sends, with `children` as given
fn snapshot(children: Value) -> wire::Message {
    let snap = KeeperSnap {
        protocol: HANDOFF_PROTOCOL,
        from_pid: 1,
        from_version: "0.1.0-beta.48".into(),
        lock: 0,
        sock: 1,
        status: HostStatus::Starting,
        source: None,
        desired: BuildSource::default(),
        background: false,
        windows: Vec::new(),
        ever_attached: false,
        since_start_ms: 0,
        since_detach_ms: 0,
        busy: false,
        since_busy_ms: 0,
        swap: None,
        keeps_agents: None,
        door: DoorSnap { listener: 2, token: "t".into(), target: None, relays: Vec::new() },
        host: None,
        children: None,
        then_switch: None,
    };
    let mut v = serde_json::to_value(&snap).unwrap();
    v["children"] = children;
    wire::Message { header: json!({ "op": "state", "snap": v }), blobs: Vec::new(), fds: Vec::new() }
}

/// #1895 step 4 (`docs/plans/keeper-removal.md` §6): a keeper of beta.48 or older sends its child table with the
/// handoff; this keeper has no children service, so the handoff is refused before any descriptor is touched, and the
/// sender rolls back and carries on with what it holds. A snapshot without one goes on to the descriptors
#[test]
fn a_handoff_that_carries_a_child_table_is_refused() {
    let table = json!({ "state": { "children": [] }, "fd_base": 3, "blob_base": 1 });
    let why = prepare(snapshot(table)).err().expect("a child table was taken");
    assert!(why.contains("no longer takes over") && why.contains("quit Centralu completely"), "{why}");
    let why = prepare(snapshot(Value::Null)).err().expect("no descriptors were passed");
    assert!(!why.contains("no longer takes over"), "a snapshot without a child table was refused for one: {why}");
}
