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
                st.host_stops_for_update = false;
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
        // Once a host is up, every copy but its own and those a launch holds is unused (#368).
        if ready {
            let k = k.clone();
            thread::spawn(move || {
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
        // What the host can be asked (`main.ts`; the line keeps its `swap` name until the host's half of the swap goes, #1895
        // step 4 PR 5): whether it takes the keeper's stop for an update on its stdin. A host of beta.48 or earlier says
        // only `keepsAgents`, and is stopped as a quit
        if let Some(report) = line.get("swap") {
            if let Ok(mut st) = self.0.state.lock() {
                st.host_stops_for_update = report.get("stopsForUpdate").and_then(Value::as_bool) == Some(true);
                self.0.broadcast(&mut st);
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

/**
 * The host folders in use: the running host's (its copy, or its verified content) and the one the next launch runs. No
 * cleanup removes them (`source::Copies::clean`).
 */
pub(in crate::keeper) fn host_dirs_in_use(st: &State) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut add = |b: &BuildSource| dirs.extend(b.copy_dir.iter().chain(b.host_dir.iter()).map(PathBuf::from));
    if let Some(s) = &st.source {
        add(s);
    }
    add(&st.desired);
    dirs
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
        prepare_host(&k, &running, &mut launch);
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
 * The environment every host this keeper starts gets:
 *   - `CC_DATA_DIR`: the folder, so user-folder apps, attachments and worktrees land in it;
 *   - `CC_KEEPER`: turns on the reports only the keeper reads (activity, what it can be asked);
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
 * Readies a launch of the build `running` for this keeper: the environment (`host_env`) and the front
 * door's token, so every host checks the one token clients hold (#280 step 3).
 *
 * The token goes as the first line on the host's stdin (#538), never in its environment, which every
 * process of this user can read for as long as the host runs (#502). Every host from 0.1.0-beta.45 on
 * reads it there (#1143).
 */
pub(super) fn prepare_host(k: &Keeper, running: &BuildSource, launch: &mut HostLaunch) {
    launch.env.extend(host_env(k, running));
    hand_token(k.door.token(), launch);
}

/// `prepare_host`'s token, on the host's stdin.
pub(in crate::keeper) fn hand_token(token: &str, launch: &mut HostLaunch) {
    let (k, v) = host_proc::HandedToken::ENV;
    launch.env.push((k.into(), v.into()));
    launch.token = Some(host_proc::HandedToken(token.to_string()));
}
