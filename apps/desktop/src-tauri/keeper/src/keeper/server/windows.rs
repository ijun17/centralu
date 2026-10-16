//! Windows: attaching, the detach when a window's connection ends, an announced relaunch, and a
//! window another keeper handed over.

use super::*;

/// How long a write to a window (an answer, a status push) may wait for it to read. A window that
/// does not take its status within this is closed (`Keeper::broadcast`).
#[cfg(not(test))]
pub(super) const WINDOW_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
pub(super) const WINDOW_WRITE_TIMEOUT: Duration = Duration::from_millis(200);

pub(super) fn attach(k: Arc<Keeper>, mut stream: UnixStream, reader: BufReader<UnixStream>, req: &Value, mut guard: Request) {
    let protocol = req.get("protocol").and_then(Value::as_u64).unwrap_or(0);
    if protocol != KEEPER_PROTOCOL as u64 {
        return reply(
            &mut stream,
            &json!({ "ok": false, "error": format!("keeper protocol mismatch (keeper {KEEPER_PROTOCOL}, app {protocol})") }),
        );
    }
    let client: Option<BuildSource> = req.get("build").cloned().and_then(|b| serde_json::from_value(b).ok());
    let Ok(push) = stream.try_clone() else { return };
    let id = {
        let Ok(mut st) = k.state.lock() else { return };
        if st.stopping {
            drop(st);
            return reply(&mut stream, &json!({ "ok": false, "error": "the keeper is stopping" }));
        }
        let id = st.count_window();
        // The window an announced relaunch started (#352): it is told so, and the grace is spent
        let relaunched = st.relaunching(Instant::now());
        if st.reattach_until.take().is_some() {
            log("a window attached after the keeper had closed one that stopped taking its status");
        }
        if st.relaunch_until.take().is_some() {
            log(if relaunched {
                "a window attached after the announced relaunch"
            } else {
                "a window attached after the relaunch grace had run out"
            });
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
        // The answer goes out before this window is added to the push list, under the same lock,
        // so no event can overtake it.
        reply(
            &mut stream,
            &json!({ "ok": true, "view": k.view(&st), "sameBuild": same, "keeperSameBuild": keeper_same, "relaunched": relaunched }),
        );
        st.subscribers.push((id, push));
        k.broadcast(&mut st);
        id
    };
    // From here the window is a subscriber, not a request a freeze has to wait for.
    guard.done();
    let _ = stream.set_read_timeout(None);
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
        st.subscribers.retain(|(i, _)| *i != id);
        st.attached = st.attached.saturating_sub(1);
        let now = Instant::now();
        st.last_detach = now;
        k.broadcast(&mut st);
        if st.attached == 0 && st.relaunching(now) {
            log("the last window closed for an announced relaunch; waiting for it to come back");
        }
        if st.attached == 0 && st.reattaching(now) {
            log(&format!("the last window was closed for not taking its status; waiting up to {}s for it to attach again", REATTACH_GRACE.as_secs()));
        }
        stop_on_detach(st.attached, st.settings.background, st.relaunching(now) || st.reattaching(now))
    };
    // Frozen: the decision waits for the thaw, when the idle rule sees no window either.
    if stop && !k.frozen.load(Ordering::SeqCst) {
        k.shutdown("the last window closed and background mode is off");
    }
}

/**
 * `relaunching` (#352): the app is about to close its window and start again from its updated
 * bundle ("Apply now"). Until the grace runs out, no window attached is not "the last window
 * left", even with background mode off, so the update cuts nothing because of that setting. The
 * next window to attach spends the grace and is told it is the relaunched one (`relaunched` in its
 * attach answer), so it can apply the switch by itself. If none comes back in time, the idle rule
 * applies as if nothing had been announced: with background mode off, the keeper stops.
 *
 * Peer-uid checked like every request (`handle`); it changes nothing a process of this user could
 * not do with `set_background` anyway, and only for a bounded time.
 */
pub(super) fn relaunching(k: &Arc<Keeper>, stream: &mut UnixStream, req: &Value) {
    let grace = relaunch_grace(req.get("graceSecs").and_then(Value::as_u64));
    {
        let Ok(mut st) = k.state.lock() else { return };
        if st.stopping {
            drop(st);
            return reply(stream, &json!({ "ok": false, "error": "the keeper is stopping" }));
        }
        st.relaunch_until = Some(Instant::now() + grace);
    }
    log(&format!("the app announced a relaunch; holding for up to {}s with no window", grace.as_secs()));
    reply(stream, &json!({ "ok": true, "graceSecs": grace.as_secs() }));
}

/// Registers a window connection another keeper handed over (step 4) and watches it.
pub(in crate::keeper) fn adopt_window(k: &Arc<Keeper>, stream: UnixStream) {
    let Ok(read_half) = stream.try_clone() else { return };
    let _ = stream.set_write_timeout(Some(WINDOW_WRITE_TIMEOUT));
    let id = {
        let Ok(mut st) = k.state.lock() else { return };
        st.add_window(stream)
    };
    let k = k.clone();
    thread::spawn(move || watch_window(k, id, BufReader::new(read_half)));
}
