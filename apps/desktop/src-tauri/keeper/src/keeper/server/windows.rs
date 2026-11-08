//! Windows: attaching, the detach when a window's connection ends, and a window another keeper
//! handed over.

use super::*;

/// How long a write to a window (an answer, a status push) may wait for it to read. A window that
/// does not take its status within this is closed (`Keeper::broadcast`).
#[cfg(not(test))]
pub(in crate::keeper) const WINDOW_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
pub(in crate::keeper) const WINDOW_WRITE_TIMEOUT: Duration = Duration::from_millis(200);

pub(super) fn attach(k: Arc<Keeper>, mut stream: UnixStream, reader: BufReader<UnixStream>, req: &Value, mut guard: Request) {
    let protocol = req.get("protocol").and_then(Value::as_u64).unwrap_or(0);
    if protocol != KEEPER_PROTOCOL as u64 {
        return reply(
            &mut stream,
            &json!({ "ok": false, "error": format!("keeper protocol mismatch (keeper {KEEPER_PROTOCOL}, app {protocol})") }),
        );
    }
    let client: Option<BuildSource> = req.get("build").cloned().and_then(|b| serde_json::from_value(b).ok());
    // Before the state lock: the judgement may run `codesign` (#1405)
    let (full, peer) = judged(&k, &stream);
    let id = {
        let Ok(mut st) = k.state.lock() else { return };
        if st.stopping {
            drop(st);
            return reply(&mut stream, &json!({ "ok": false, "error": "the keeper is stopping" }));
        }
        let id = st.count_window();
        if st.reattach_until.take().is_some() {
            log("a window attached after the keeper had closed one that stopped taking its status");
        }
        let same = match (&client, &st.source) {
            (Some(c), Some(s)) => Some(c.same_build(s)),
            _ => None,
        };
        // Whether the keeper itself is from the window's build (step 4): None for a keeper that
        // cannot say (older than step 4)
        let keeper_same = match (&client, &k.info.build) {
            (Some(c), Some(b)) => Some(c.same_build(b)),
            _ => None,
        };
        // The answer is the first line the window's writer sends, queued under the same lock as
        // the window joins the push list, so no event can overtake it.
        // The request has been read: the reader waits for the window's end with no bound
        let _ = stream.set_read_timeout(None);
        let Some(w) = Window::start(&k, id, stream, full, peer) else {
            st.attached = st.attached.saturating_sub(1);
            return;
        };
        // Its own view: the token only for a window (#1405, `Window::full`)
        let answer = json!({ "ok": true, "view": k.view(&st, w.full), "sameBuild": same, "keeperSameBuild": keeper_same });
        w.push.answer(json_line(&answer));
        st.subscribers.push(w);
        k.broadcast(&mut st);
        id
    };
    // From here the window is a subscriber, not a request a freeze has to wait for.
    guard.done();
    watch_window(k, id, reader);
}

/// Waits for an attached window to go away (its connection ending is the detach) and applies
/// background mode. Shared by `attach` and a keeper that took the window over in a handoff.
pub(in crate::keeper) fn watch_window(k: Arc<Keeper>, id: u64, mut reader: BufReader<UnixStream>) {
    // The window says nothing more; the connection ending is the detach.
    while let Ok(Some(_)) = read_line(&mut reader) {}
    // Handed over: the window is the next keeper's to count (it sees the same end).
    if k.handed_over.load(Ordering::SeqCst) {
        return;
    }
    let stop = {
        let Ok(mut st) = k.state.lock() else { return };
        st.remove_window(id);
        st.attached = st.attached.saturating_sub(1);
        let now = Instant::now();
        st.last_detach = now;
        k.broadcast(&mut st);
        if st.attached == 0 && st.reattaching(now) {
            log(&format!("the last window was closed for not taking its status; waiting up to {}s for it to attach again", REATTACH_GRACE.as_secs()));
        }
        stop_on_detach(st.attached, st.settings.background, st.reattaching(now))
    };
    // Frozen: the decision waits for the thaw, when the idle rule sees no window either.
    if stop && !k.frozen.load(Ordering::SeqCst) {
        k.shutdown("the last window closed and background mode is off");
    }
}

/// Registers a window connection another keeper handed over (step 4) and watches it.
pub(in crate::keeper) fn adopt_window(k: &Arc<Keeper>, stream: UnixStream) {
    let Ok(read_half) = stream.try_clone() else { return };
    let _ = stream.set_write_timeout(Some(WINDOW_WRITE_TIMEOUT));
    // Judged again from the socket another keeper passed: the peer's record travels with it (#1405)
    let (full, peer) = judged(k, &stream);
    let id = {
        let Ok(mut st) = k.state.lock() else { return };
        st.add_window(k, stream, full, peer)
    };
    let k = k.clone();
    thread::spawn(move || watch_window(k, id, BufReader::new(read_half)));
}

/// Whether the peer of an attaching or handed-over window is a Centralu window (#1405, #2119 `Keeper::judge_attaching`),
/// logged with why when it is not: it then gets the limited credential, and its own log says so too. With a window, its
/// pid and start as they were read around the judgement (`Window::peer`).
fn judged(k: &Keeper, stream: &UnixStream) -> (bool, Option<window_peer::Attached>) {
    match k.judge_attaching(stream) {
        Ok((window_peer::Taken::ByPath, peer)) => (true, peer),
        Ok((window_peer::Taken::Known, peer)) => {
            log("an attaching window whose executable no longer reads as the window's is one this keeper took before (an update replaced it)");
            (true, peer)
        }
        Err(why) => {
            log(&format!("an attaching client gets the limited credential: {why}"));
            (false, None)
        }
    }
}
