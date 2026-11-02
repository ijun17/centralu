//! The headless keeper (docs/plans/remote-keeper.md §8, step 3): the keeper `centralu serve` starts on a Linux remote in the
//! host's place, with no window.
//!
//! `serve` starts it with `--headless --port <n> --node <path>` and the key on its stdin, as it starts a host without a
//! keeper, and stays its parent. What differs from a keeper a window started:
//!
//! - **The door is `serve`'s own.** It listens on the port `serve` recorded, and the token it hands each host is the line
//!   `serve` wrote (the key; a host that takes verifiers also reads `serve.json`, which `CC_SERVE_STATE` names), so the
//!   hub's cached credentials, `--connection` and the ssh forward do not move.
//! - **Nothing ends it for the lack of a window** (`idle_decision`). It ends when it is stopped, when its launcher's pipe
//!   closes (a launcher killed outright, as a host's `--watch-parent` ends it today) or on SIGINT, SIGTERM and SIGHUP,
//!   each of which stops everything in order, as `serve` forwards them to a host.
//! - **No peer is a window** (`Keeper::window_exes`): `status` hands out the limited credential only, and `switch` and
//!   `upgrade` are refused to everyone (#1405).
//! - **`stop` takes `ifIdle` and `forUpdate`** and has the host decide (`stop`), since a host under a keeper takes no
//!   `host.stop` of its own.
//! - **It says when it is ready** on stdout, `{"ready":true,"port":..,"hostPid":..}`, with no token: the one line `serve`
//!   waits for (`readyPort`).

use super::*;
use std::io::{BufRead, Read};
use std::sync::mpsc;

/// How long a headless `stop` waits for the host to answer its control line. The host answers at once; one that does not
/// is an older build, hung, or not running.
#[cfg(not(test))]
pub(super) const STOP_ANSWER_WAIT: Duration = Duration::from_secs(5);
#[cfg(test)]
pub(super) const STOP_ANSWER_WAIT: Duration = Duration::from_millis(600);

/// How long the keeper waits, after the host said yes to a stop, for it to leave. The host bounds its own leave at ten
/// seconds (`Shutdown`); `shutdown` ends whatever is left after that.
pub(super) const HOST_LEAVE_WAIT: Duration = Duration::from_secs(20);

/// The token out of the line `serve` writes first on the keeper's stdin: `{"key":".."}`, or `{"token":".."}` as a keeper
/// hands a host (`HandedToken::line`). The same line the host reads (`readHandedToken`).
pub(super) fn token_of_line(line: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(line.trim()).map_err(|_| "the token line on stdin is not JSON".to_string())?;
    match v.get("token").or_else(|| v.get("key")).and_then(Value::as_str) {
        Some(t) if !t.trim().is_empty() => Ok(t.to_string()),
        _ => Err("the token line on stdin has no token".to_string()),
    }
}

/// Reads that line. Nothing else on stdin until the launcher's pipe closes (`watch`).
pub(super) fn read_token() -> Result<String, String> {
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        Ok(0) => Err("stdin ended before the token line".to_string()),
        Ok(_) => token_of_line(&line),
        Err(e) => Err(format!("could not read the token line on stdin: {e}")),
    }
}

/// The front door of a keeper: `port` and the handed token when headless, else a free port and a fresh token.
pub(super) fn open_door(port: Option<u16>, handed: Option<String>) -> std::io::Result<FrontDoor> {
    let token = match handed {
        Some(t) => t,
        None => front_door::new_token()?,
    };
    FrontDoor::open(port.unwrap_or(0), token)
}

/// Starts what ends a headless keeper from outside: a stop signal and its launcher's pipe closing. Each stops everything.
pub(super) fn watch(k: &Arc<Keeper>) {
    os::catch_stop_signals();
    let k2 = k.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(100));
        if os::stop_signalled() {
            stop_from_outside(&k2, "asked to stop by a signal");
            return;
        }
    });
    let k3 = k.clone();
    thread::spawn(move || {
        let mut sink = [0u8; 256];
        let mut stdin = std::io::stdin().lock();
        // Whatever the launcher writes besides the token is not for the keeper; its end is
        while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
        stop_from_outside(&k3, "the launcher's pipe closed");
    });
}

/// The one line `serve` waits for. No token: stdout is not where the key goes.
pub(super) fn ready_line(port: u16, host_pid: Option<u32>) -> String {
    json!({ "ready": true, "port": port, "hostPid": host_pid }).to_string()
}

/// What the host said to a stop it was asked.
pub(super) enum Asked {
    /// `ifIdle` and something runs: what runs, as the host reported it. Nothing was changed.
    Busy(Value),
    /// It will stop itself, and refuses every new call from now on if `ifIdle` was asked.
    Yes,
    /// It did not answer (an older build, a hung one, none running).
    Silent,
}

/// Sends the host its control line, `{"op":"stop","ifIdle":..,"forUpdate":..}`, and waits for `stopAnswer`. `Err` when a stop is
/// being asked already: one at a time.
pub(super) fn ask_host(k: &Keeper, if_idle: bool, for_update: bool) -> Result<Asked, &'static str> {
    let (tx, rx) = mpsc::channel();
    {
        let Ok(mut slot) = k.stop_reply.lock() else { return Err("the keeper is failing") };
        if slot.is_some() {
            return Err("another stop is being asked; try again in a moment");
        }
        *slot = Some(tx);
    }
    let line = json!({ "op": "stop", "ifIdle": if_idle, "forUpdate": for_update }).to_string();
    let answer = k.sup.send_line(&line).ok().and_then(|()| rx.recv_timeout(STOP_ANSWER_WAIT).ok());
    if let Ok(mut slot) = k.stop_reply.lock() {
        *slot = None;
    }
    Ok(match answer {
        Some(a) if a.get("ok").and_then(Value::as_bool) == Some(false) => Asked::Busy(a),
        Some(_) => Asked::Yes,
        None => Asked::Silent,
    })
}

/// `stop` on a headless keeper (`ifIdle`, `forUpdate`): the host decides in one step. With `ifIdle` it answers busy when anything
/// runs, or yes and refuses every new call from then on (`lifecycle/stop-gate.ts`); with yes, or without `ifIdle`, it stops as
/// `host.stop` does, listing the turns it ends for the next host when `forUpdate` (#1618), and the keeper waits for it to leave
/// and ends what is left.
///
/// A host that does not answer (an older build, a hung one) is stopped by the keeper as before, unless `ifIdle`: nothing then
/// says it is idle, so nothing is stopped.
pub(super) fn stop(k: &Arc<Keeper>, mut stream: UnixStream, req: &Value) {
    let flag = |name: &str| req.get(name).and_then(Value::as_bool).unwrap_or(false);
    let (if_idle, for_update) = (flag("ifIdle"), flag("forUpdate"));
    match ask_host(k, if_idle, for_update) {
        Err(why) => reply(&mut stream, &json!({ "ok": false, "error": why })),
        Ok(Asked::Busy(a)) => reply(&mut stream, &json!({ "ok": false, "busy": true, "activity": a.get("busy"), "calls": a.get("calls") })),
        Ok(Asked::Yes) => {
            reply(&mut stream, &json!({ "ok": true }));
            drop(stream);
            k.shutdown_after("asked to stop (centralu serve --stop)", Ending::HostLeaving);
        }
        Ok(Asked::Silent) if if_idle => {
            log("stop {ifIdle}: the host did not answer, so nothing says it is idle; not stopping");
            reply(&mut stream, &json!({ "ok": false, "error": "the host did not answer the idle check; nothing was stopped" }));
        }
        Ok(Asked::Silent) => {
            reply(&mut stream, &json!({ "ok": true }));
            drop(stream);
            k.shutdown("asked to stop (centralu serve --stop); the host did not answer");
        }
    }
}

/// A stop from outside the control socket (a signal, the launcher's pipe closing): the same stop `serve --stop` makes, as a host
/// `centralu serve` runs without a keeper takes a signal, not the quit the person's Quit completely marks (#1143).
pub(super) fn stop_from_outside(k: &Arc<Keeper>, why: &str) {
    match ask_host(k, false, false) {
        Ok(Asked::Yes) => k.shutdown_after(why, Ending::HostLeaving),
        _ => k.shutdown(why),
    }
}

impl Keeper {
    /// Waits for the host, which said yes to a stop and is leaving, to be gone. It is not started again when it goes.
    pub(super) fn wait_for_host_to_leave(&self) {
        let Some(pid) = self.sup.pid() else { return };
        self.sup.mark_stopping();
        let end = Instant::now() + HOST_LEAVE_WAIT;
        while Instant::now() < end && self.sup.pid() == Some(pid) {
            thread::sleep(Duration::from_millis(50));
        }
    }
}
