//! What the keeper hears from its host and how it launches one: the status sink, the launcher and
//! the environment every host gets.

use super::*;

pub(in crate::keeper) fn sink(k: &Arc<Keeper>) -> Arc<dyn StatusSink> {
    Arc::new(KeeperSink(k.clone()))
}

struct KeeperSink(Arc<Keeper>);

impl StatusSink for KeeperSink {
    fn status(&self, status: &HostStatus) {
        let k = &self.0;
        if k.handed_over.load(Ordering::SeqCst) {
            return;
        }
        // Clients only ever see the front door (#280 step 3): a ready host becomes the door's
        // target, and what the windows are told is the door's port and token, not the host's.
        let shown = match status {
            HostStatus::Ready(host) => {
                if host.token != k.door.token() {
                    log("the host's token is not the front door's; clients will be refused");
                }
                k.door.point_at(Some(host.port));
                HostStatus::Ready(HostInfo { port: k.door.port(), token: k.door.token().to_string() })
            }
            other => {
                k.door.point_at(None);
                other.clone()
            }
        };
        let ready = {
            let Ok(mut st) = k.state.lock() else { return };
            st.status = shown.clone();
            if !matches!(status, HostStatus::Ready(_)) {
                st.busy = false;
                st.keeps_agents = None;
            }
            k.broadcast(&mut st);
            matches!(status, HostStatus::Ready(_))
        };
        k.write_state_file();
        match status {
            HostStatus::Ready(info) => log(&format!("host ready on port {} behind {} (pid {:?})", info.port, k.door.url(), k.sup.pid())),
            HostStatus::Failed { message } => log(&format!("host gave up: {message}")),
            HostStatus::Restarting { attempt } => log(&format!("host restarting (attempt {attempt})")),
            HostStatus::Starting => {}
        }
        // Once a host is up, every copy but its own and those a launch or swap holds is unused.
        // Which copy is the running host's is read when the cleanup runs, not now: a swap may have
        // adopted its new host in between (#368).
        if ready {
            let k = k.clone();
            thread::spawn(move || {
                if let Some(hold) = test_clean_hold() {
                    log(&format!("holding {}ms before removing unused host copies (CC_KEEPER_CLEAN_HOLD_MS)", hold.as_millis()));
                    thread::sleep(hold);
                }
                let removed = k.copies.clean(|| k.state.lock().map(|st| host_dirs_in_use(&st)).unwrap_or_default());
                if !removed.is_empty() {
                    log(&format!("removed unused host copies: {}", removed.join(", ")));
                }
            });
        }
    }

    /// The host's activity report, `{"activity":{"busy":bool}}` on its stdout — the one thing
    /// the keeper reads from the host besides the ready line. It feeds the idle rule.
    fn json_line(&self, line: &Value) -> bool {
        // The swap's two reports (#280 step 3, swap-control.ts): what a swap costs with this host,
        // and what a draining host finished or cut
        if let Some(keeps) = line.pointer("/swap/keepsAgents").and_then(Value::as_bool) {
            if let Ok(mut st) = self.0.state.lock() {
                st.keeps_agents = Some(keeps);
                self.0.broadcast(&mut st);
            }
            return true;
        }
        if let Some(report) = line.get("drained") {
            log(&format!("old host drained: {report}"));
            if let Ok(mut st) = self.0.state.lock() {
                st.drained = Some(report.clone());
            }
            return true;
        }
        let Some(busy) = line.pointer("/activity/busy").and_then(Value::as_bool) else {
            return false;
        };
        if let Ok(mut st) = self.0.state.lock() {
            if busy || st.busy {
                st.last_busy = Instant::now();
            }
            if st.busy != busy {
                st.busy = busy;
                self.0.broadcast(&mut st);
            }
        }
        true
    }
}

/// A test hook: wait this long after a host is ready before removing unused copies, so a test can
/// have the cleanup land after a swap has copied its build and before it starts it (#368).
pub(super) fn test_clean_hold() -> Option<Duration> {
    std::env::var("CC_KEEPER_CLEAN_HOLD_MS").ok()?.trim().parse::<u64>().ok().map(Duration::from_millis)
}

/// Builds each launch: copies the desired build to its per-build folder and runs it from there.
pub(in crate::keeper) fn launcher(k: &Arc<Keeper>) -> Launcher {
    let k = k.clone();
    Arc::new(move || {
        let desired = k.state.lock().map(|s| s.desired.clone()).map_err(|_| LaunchError::Fatal("keeper state poisoned".into()))?;
        let db = k.data.join("store.db").to_string_lossy().to_string();
        let extra = vec!["--db".to_string(), db];
        let mut running = desired.clone();
        // Held until the state below names the copy as the running host's, so no cleanup can take
        // it in between (#368)
        let mut claim = None;
        let mut launch: HostLaunch = if desired.host_dir.is_some() {
            let held = k.copies.claim(&desired).map_err(LaunchError::Retry)?;
            running.copy_dir = Some(held.path().to_string_lossy().to_string());
            let launch = host_proc::bundled_launch(&held.path().join("main.mjs"), &extra)?;
            claim = Some(held);
            launch
        } else {
            host_proc::source_launch(&extra)
        };
        prepare_host(&k, &running, running.copy_dir.as_deref().map(Path::new), &mut launch);
        log(&format!("starting host {} from {}", running.key(), running.copy_dir.as_deref().unwrap_or("source")));
        if let Ok(mut st) = k.state.lock() {
            st.source = Some(running);
        }
        drop(claim);
        k.write_state_file();
        Ok(launch)
    })
}

/**
 * The environment every host this keeper starts gets, normal start or swap alike:
 *   - `CC_DATA_DIR`: the folder, so user-folder apps, attachments and worktrees land in it;
 *   - `CC_KEEPER`: turns on the reports only the keeper reads (activity, swap);
 *   - `CC_HOST_SOURCE`: the build record its `hello_ok` repeats;
 *   - `CC_FRONT_DOOR`: the address the host gives the Codex bridge instead of its own port.
 *
 * Not the token: `prepare_host` hands it over on stdin.
 */
pub(super) fn host_env(k: &Keeper, running: &BuildSource) -> Vec<(String, String)> {
    vec![
        ("CC_DATA_DIR".into(), k.data.to_string_lossy().to_string()),
        ("CC_KEEPER".into(), "1".into()),
        ("CC_HOST_SOURCE".into(), serde_json::to_string(running).unwrap_or_default()),
        ("CC_FRONT_DOOR".into(), k.door.url()),
    ]
}

/**
 * Readies a launch of the build `running`, from the host folder `host_dir` (None: the source), for this
 * keeper: the environment (`host_env`) and the front door's token, so every host checks the one token
 * clients hold (#280 step 3).
 *
 * The token goes as the first line on the host's stdin (#538), never in its environment, which every
 * process of this user can read for as long as the host runs (#502). A host from before #538 does not
 * read that line and would make up a token no client holds, so a bundle that does not say
 * `tokenOnStdin` in its `bundle-info.json` still gets it in `CC_HOST_TOKEN`, as before, and the log says
 * so. That is the one way left for the token into an environment, for builds older than this keeper.
 */
pub(super) fn prepare_host(k: &Keeper, running: &BuildSource, host_dir: Option<&Path>, launch: &mut HostLaunch) {
    launch.env.extend(host_env(k, running));
    hand_token(k.door.token(), host_dir, launch, &|m| log(m));
}

/// `prepare_host`'s token, by what the host in `host_dir` reads.
pub(in crate::keeper) fn hand_token(token: &str, host_dir: Option<&Path>, launch: &mut HostLaunch, log: &dyn Fn(&str)) {
    if takes_token_on_stdin(host_dir) {
        let (k, v) = host_proc::HandedToken::ENV;
        launch.env.push((k.into(), v.into()));
        launch.token = Some(host_proc::HandedToken(token.to_string()));
    } else {
        log(&format!(
            "the host in {} is older than #538: it gets the token in its environment",
            host_dir.map(|d| d.display().to_string()).unwrap_or_default()
        ));
        launch.env.push(("CC_HOST_TOKEN".into(), token.to_string()));
    }
}

/// Whether the host in `host_dir` reads its token from stdin: its `bundle-info.json` says
/// `"tokenOnStdin": 1` (written by `packages/agent-host/scripts/bundle.mjs` since #538). The source
/// (`None`) always does.
pub(in crate::keeper) fn takes_token_on_stdin(host_dir: Option<&Path>) -> bool {
    let Some(dir) = host_dir else { return true };
    std::fs::read_to_string(dir.join("bundle-info.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v.get("tokenOnStdin").and_then(serde_json::Value::as_u64) == Some(1))
}
