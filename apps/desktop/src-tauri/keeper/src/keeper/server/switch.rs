//! Switching builds: a blue-green swap of the host, a handoff of the keeper itself, or both, and a
//! keeper from verified content moving to the next build's content.

use super::*;

/// The answer to a second switch (or a restart, an upgrade) while one runs.
pub(super) const SWITCH_IN_PROGRESS: &str = "a build switch is already in progress";

/// Switches the host to the requesting app's build: a blue-green swap when a host is up
/// (`swap.rs`), else the next start runs it. The build stamp is re-read from the folder
/// rather than taken from the request, so the keeper's record says what will actually run.
pub(super) fn switch(k: Arc<Keeper>, stream: &mut UnixStream, req: &Value) {
    let asked: Option<BuildSource> = req.get("source").cloned().and_then(|s| serde_json::from_value(s).ok());
    let Some(asked) = asked else {
        return reply(stream, &json!({ "ok": false, "error": "switch needs a source" }));
    };
    let keeper_exe = req.pointer("/keeper/exe").and_then(Value::as_str).map(PathBuf::from);
    // A keeper from verified content never starts anything from the asking window's bundle: it
    // verifies that bundle's signed content and moves to its own copy of it (thin-shell plan §10
    // step 5). The bundle comes from the keeper executable the window names, else from its path.
    if let Some(src) = content_route(&k.origin, keeper_exe.as_deref(), asked.bundle_path.as_deref()) {
        if !start_switching(&k, stream) {
            return;
        }
        reply(stream, &json!({ "ok": true }));
        log(&format!(
            "switching to the build at {}: verifying its content first",
            asked.bundle_path.as_deref().unwrap_or("an unnamed bundle")
        ));
        thread::spawn(move || move_to_content(k, src, asked, true));
        return;
    }
    let next = match (host_build(&asked), asked.host_dir.as_deref()) {
        (Some(next), _) => next,
        (None, Some(dir)) => return reply(stream, &json!({ "ok": false, "error": format!("no host in {dir}") })),
        (None, None) if asked.commit == "dev" => BuildSource::dev(),
        (None, None) => return reply(stream, &json!({ "ok": false, "error": "switch needs a host folder" })),
    };
    // The new build's keeper executable, from the window asking (step 4): hand the keeper over first
    if let Some(exe) = keeper_exe {
        if k.info.build.as_ref().map(|b| !b.same_build(&next)).unwrap_or(true) {
            if !start_switching(&k, stream) {
                return;
            }
            reply(stream, &json!({ "ok": true }));
            log(&format!("switching to {}: the keeper first, from {}", next.key(), exe.display()));
            thread::spawn(move || move_keeper(k, exe, next, true));
            return;
        }
    }
    log(&format!("switching the host to {} (from {})", next.key(), next.bundle_path.as_deref().unwrap_or("?")));
    begin_switch(k, next, None, Some(stream));
}

/// Starts a host switch already decided on: a blue-green swap when a host is up, else the next
/// start runs the new build. `stream`, when there is one, is answered once it is under way.
pub(in crate::keeper) fn begin_switch(k: Arc<Keeper>, next: BuildSource, keeper_message: Option<String>, mut stream: Option<&mut UnixStream>) {
    let blue_green = {
        let Ok(mut st) = k.state.lock() else { return };
        // A stream means a fresh request; without one the caller (a keeper move) already holds it
        if st.swapping && stream.is_some() {
            drop(st);
            if let Some(s) = stream.as_mut() {
                reply(s, &json!({ "ok": false, "error": SWITCH_IN_PROGRESS }));
            }
            return;
        }
        // Only a host that is up has anything to hand over; otherwise the next start simply runs
        // the new build
        let up = matches!(st.status, HostStatus::Ready(_)) && k.sup.is_running() && next.host_dir.is_some();
        if up {
            st.swapping = true;
        } else {
            st.swapping = false;
            st.desired = next.clone();
            if let Some(m) = &keeper_message {
                // Nothing to swap, but the window should still hear why the keeper stayed behind
                st.swap = Some(SwapView { keeper_message: Some(m.clone()), ..SwapView::begun(Phase::Done, next.clone(), st.source.clone()) });
                k.broadcast(&mut st);
            }
        }
        up
    };
    if let Some(s) = stream {
        reply(s, &json!({ "ok": true }));
    }
    if blue_green {
        thread::spawn(move || swap_to(k, next, keeper_message));
    } else if !k.sup.bounce() {
        // A host still starting is bounced into the new build; one that had given up starts fresh
        k.sup.restart(sink(&k), launcher(&k));
    }
}

/**
 * `upgrade`: hands the keeper over to the keeper at `exe` (of build `source`), leaving the host
 * alone (#280 step 4). The app's switch reaches the same thing through `switch` with `keeper`; this
 * one exists for a keeper that is behind while the host is not, and for the integration test.
 */
pub(super) fn upgrade(k: Arc<Keeper>, stream: &mut UnixStream, req: &Value) {
    let Some(exe) = req.get("exe").and_then(Value::as_str).map(PathBuf::from) else {
        return reply(stream, &json!({ "ok": false, "error": "upgrade needs exe" }));
    };
    let asked: Option<BuildSource> = req.get("source").cloned().and_then(|s| serde_json::from_value(s).ok());
    // From verified content, the executable only says which bundle's content to verify (step 5)
    if let Some(src) = content_route(&k.origin, Some(&exe), None) {
        if !start_switching(&k, stream) {
            return;
        }
        reply(stream, &json!({ "ok": true }));
        thread::spawn(move || move_to_content(k, src, asked.unwrap_or_default(), false));
        return;
    }
    let Some(target) = asked.as_ref().and_then(host_build) else {
        return reply(stream, &json!({ "ok": false, "error": "upgrade needs a source with a host folder" }));
    };
    if !start_switching(&k, stream) {
        return;
    }
    reply(stream, &json!({ "ok": true }));
    thread::spawn(move || move_keeper(k, exe, target, false));
}

/**
 * Hands this keeper over to the keeper at `exe` (#280 step 4), then, when `switch_host` and the
 * host is of another build, has the new keeper swap the host too. On success this never returns:
 * the process exits once the new keeper has committed.
 *
 * If the handoff fails, this keeper carries on as it was (`handoff::give` rolled it back), and a
 * host switch that was asked for still runs here, under this keeper: the window is told the keeper
 * stayed behind and why.
 */
pub(super) fn move_keeper(k: Arc<Keeper>, exe: PathBuf, target: BuildSource, switch_host: bool) {
    let (from, host_differs) = match k.state.lock() {
        Ok(st) => (st.source.clone(), st.source.as_ref().map(|s| !s.same_build(&target)).unwrap_or(true)),
        Err(_) => return,
    };
    let then_switch = (switch_host && host_differs).then(|| target.clone());
    let begun = SwapView::begun(Phase::HandingOver, target.clone(), from);
    let view = |phase: Phase, message: Option<String>, keeper_message: Option<String>| SwapView {
        phase,
        message,
        keeper_message,
        ..begun.clone()
    };
    if let Ok(mut st) = k.state.lock() {
        st.swap = Some(view(Phase::HandingOver, None, None));
        k.broadcast(&mut st);
    }
    let Err(why) = handoff::give(&k, &exe, &target, then_switch) else { return };
    log(&format!("the keeper stays on its build: {why}"));
    if switch_host && host_differs {
        // The host switch still happens, under this keeper
        begin_switch(k, target, Some(why), None);
        return;
    }
    if let Ok(mut st) = k.state.lock() {
        st.swapping = false;
        st.swap = Some(view(Phase::Failed, Some(format!("could not hand over to the new build's keeper: {why}")), Some(why)));
        k.broadcast(&mut st);
    }
}

/**
 * Which way a switch or an upgrade goes. `None`: a keeper started directly, or from an unsigned
 * copy (a Linux window's, `carried.rs`), hands over to the executable the window names, as every
 * keeper before step 5 did. `Some`: a keeper from verified
 * content takes the new build's signed content instead (`move_to_content`), from the bundle around
 * that executable, else from the bundle the window names; `Some(None)` when there is neither, which
 * `move_to_content` refuses.
 */
pub(in crate::keeper) fn content_route(origin: &content::Origin, exe: Option<&Path>, bundle: Option<&str>) -> Option<Option<PathBuf>> {
    if !origin.signed() {
        return None;
    }
    Some(exe.and_then(content::bundle_content_of_exe).or_else(|| bundle.map(|b| content::bundle_content_of_bundle(Path::new(b)))))
}

/// Marks a switch as running, or answers that one already is. True when this request may go on.
pub(super) fn start_switching(k: &Keeper, stream: &mut UnixStream) -> bool {
    let Ok(mut st) = k.state.lock() else { return false };
    if st.swapping {
        drop(st);
        reply(stream, &json!({ "ok": false, "error": SWITCH_IN_PROGRESS }));
        return false;
    }
    st.swapping = true;
    true
}

/// The build in the host folder a `switch` or `upgrade` names, its stamp read from the folder; None
/// when it names none or there is no host in it.
pub(super) fn host_build(asked: &BuildSource) -> Option<BuildSource> {
    let dir = Path::new(asked.host_dir.as_deref()?);
    dir.join("main.mjs").is_file().then(|| BuildSource::from_host_dir(dir, asked.bundle_path.clone(), asked.version.clone()))
}

/**
 * The host folders in use: the running host's (its copy, or its verified content), the one the next
 * launch runs, and the target of a swap or handoff while one runs. No cleanup removes them
 * (`source::Copies::clean`): a handoff that failed leaves its host switch to `begin_switch`, whose
 * swap claims the target only once its thread runs, and the target is kept from here until then.
 */
pub(in crate::keeper) fn host_dirs_in_use(st: &State) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut add = |b: &BuildSource| dirs.extend(b.copy_dir.iter().chain(b.host_dir.iter()).map(PathBuf::from));
    if let Some(s) = &st.source {
        add(s);
    }
    add(&st.desired);
    if st.swapping {
        if let Some(sw) = &st.swap {
            add(&sw.target);
        }
    }
    dirs
}

/**
 * A keeper running from verified content moves to the next build (thin-shell plan §10 step 5): it
 * verifies `src`, the new bundle's signed content, with the shell's rules and the built-in keys,
 * copies it into `<data>/content/<version>/` (or reuses the copy there if it verifies), and hands over
 * to the keeper inside that copy with `--host-source` naming the copy's host (`move_keeper`). With
 * `switch_host`, the new keeper then swaps the host to that same verified host. Nothing in the bundle
 * is ever started.
 *
 * A refusal leaves this keeper and its host where they are, and the window is told why through the
 * swap view, as for any failed switch (`refused` carries the id). The new copy is held from the
 * moment it is placed until the handoff commits or fails, so no cleanup can take it in between.
 */
pub(super) fn move_to_content(k: Arc<Keeper>, src: Option<PathBuf>, asked: BuildSource, switch_host: bool) {
    let keys = match keys::trusted_keys() {
        Ok(keys) => keys,
        Err(e) => return refuse(&k, &asked, content::Refusal::new("content", format!("the built-in keys are unreadable: {e}"))),
    };
    let say = |m: &str| log(m);
    let v = content::Verifier { keys: &keys, platform: content_verify::current_platform(), log: &say };
    let checked = src
        .ok_or_else(|| content::Refusal::new("no-content", "the new build names no bundle to take its signed content from"))
        .and_then(|src| v.check(&k.data, &src).map(|(m, bytes)| (src, m, bytes)));
    let (src, manifest, bytes) = match checked {
        Ok(c) => c,
        Err(r) => return refuse(&k, &asked, r),
    };
    let folder = content::version_dir(&k.data, &manifest.app_version);
    let running = k.state.lock().map(|st| host_dirs_in_use(&st)).unwrap_or_default();
    let claim = k.copies.claim_content(
        &folder,
        &running,
        || content::Refusal::new("copy", "the keeper is handing itself over to another keeper"),
        |in_use| v.place(&k.data, &src, &manifest, &bytes, in_use),
    );
    let claim = match claim {
        Ok(c) => c,
        Err(r) => return refuse(&k, &asked, r),
    };
    let target = BuildSource::from_host_dir(claim.path(), asked.bundle_path.clone(), Some(manifest.app_version.clone()));
    if k.origin.dir() == Some(claim.folder()) {
        // This keeper already runs that content: only the host may have to move
        log(&format!("the keeper already runs {}", claim.folder().display()));
        let host_differs = k.state.lock().map(|st| st.source.as_ref().map(|s| !s.same_build(&target)).unwrap_or(true)).unwrap_or(false);
        if switch_host && host_differs {
            begin_switch(k.clone(), target, None, None);
        } else if let Ok(mut st) = k.state.lock() {
            st.swapping = false;
            k.broadcast(&mut st);
        }
        return;
    }
    let exe = claim.folder().join(super::exe::KEEPER_EXE);
    log(&format!("verified Centralu {} into {}; handing the keeper over to it", manifest.app_version, claim.folder().display()));
    // Returns only if the handoff failed and was rolled back; the claim is given up then
    move_keeper(k.clone(), exe, target, switch_host);
    drop(claim);
}

/// The new build's content was refused: nothing moves, and the window is told why.
pub(super) fn refuse(k: &Arc<Keeper>, asked: &BuildSource, r: content::Refusal) {
    log(&format!("the keeper stays on its build: the new build's content was refused ({}): {}", r.reason, r.message));
    let Ok(mut st) = k.state.lock() else { return };
    st.swapping = false;
    st.swap = Some(SwapView {
        message: Some(r.message),
        refused: Some(r.reason.to_string()),
        refused_check: r.check.map(String::from),
        refused_file: r.file,
        refused_hashes: r.hashes.map(|(a, b)| [a, b]),
        ..SwapView::begun(Phase::Failed, asked.clone(), st.source.clone())
    });
    k.broadcast(&mut st);
}

/// Runs a blue-green swap (`swap.rs`) and applies its outcome to the keeper's state.
pub(in crate::keeper) fn swap_to(k: Arc<Keeper>, next: BuildSource, keeper_message: Option<String>) {
    let (from, current_copy) = match k.state.lock() {
        Ok(mut st) => {
            st.drained = None;
            (st.source.clone(), st.source.as_ref().and_then(|s| s.copy_dir.clone()).map(PathBuf::from))
        }
        Err(_) => return,
    };
    let begun = SwapView { keeper_message, ..SwapView::begun(Phase::Starting, next.clone(), from.clone()) };
    let view = |phase: Phase| SwapView { phase, ..begun.clone() };
    let show = |v: SwapView| {
        log(&format!(
            "swap to {}: {:?}{}",
            v.target.key(),
            v.phase,
            v.message.as_deref().map(|m| format!(" ({m})")).unwrap_or_default()
        ));
        if let Ok(mut st) = k.state.lock() {
            st.swap = Some(v);
            k.broadcast(&mut st);
        }
    };
    let prepare = |b: &BuildSource, launch: &mut host_proc::HostLaunch| prepare_host(&k, b, launch);
    let standby = |pid: Option<u32>| k.children.set_standby(pid);
    let drained = || k.state.lock().ok().and_then(|st| st.drained.clone());
    let progress = |phase: Phase| show(view(phase));
    let adopt = |host: host_proc::Adopted, running: BuildSource| -> Result<(), String> {
        if let Ok(mut st) = k.state.lock() {
            st.source = Some(running.clone());
            st.desired = running;
        }
        k.write_state_file();
        k.sup.adopt(host, sink(&k), launcher(&k)).map_err(|mut h| {
            host_proc::stop_child(&mut h.child);
            "the keeper was still supervising another host".to_string()
        })
    };
    let outcome = swap::run(&swap::Plan {
        data: &k.data,
        copies: &k.copies,
        next: next.clone(),
        current_copy,
        sup: &k.sup,
        door: &k.door,
        drain_bound: swap::drain_bound(),
        prepare: &prepare,
        standby: &standby,
        drained: &drained,
        progress: &progress,
        adopt: &adopt,
    });
    match outcome {
        swap::Outcome::Done { cut } => show(SwapView { cut, ..view(Phase::Done) }),
        // The running host was never touched
        swap::Outcome::NotStarted(message) => show(SwapView { message: Some(message), ..view(Phase::Failed) }),
        swap::Outcome::FailedAfterDrain { message, cut } => {
            // The old host is gone and its lock released: start its build again (swap.rs)
            if let Ok(mut st) = k.state.lock() {
                if let Some(prev) = from.clone() {
                    st.desired = prev.clone();
                    st.source = Some(prev);
                }
            }
            show(SwapView { message: Some(message.clone()), rolled_back: true, cut, ..view(Phase::Failed) });
            start_again_after_failed_swap(&k, message);
        }
    }
    if let Ok(mut st) = k.state.lock() {
        st.swapping = false;
        k.broadcast(&mut st);
    }
    k.write_state_file();
}

/**
 * After a swap that failed once the old host had drained: starts the previous build again. Refused
 * while the old host's watcher still runs (a host that would not stop, #840 item 1): that watcher
 * starts it once the host ends. Until then nothing serves, and the front door already points
 * nowhere, so the windows are told the host failed instead of keeping the old host's Ready.
 */
pub(super) fn start_again_after_failed_swap(k: &Arc<Keeper>, message: String) {
    if !k.sup.restart(sink(k), launcher(k)) {
        log("the previous build is not started again yet: the old host's watcher still runs");
        // Retry asks for the same restart and is refused the same way while that host runs, so the
        // person is told the one thing that ends it
        sink(k).status(&HostStatus::Failed { message: format!("{message}\n{STUCK_HOST}") });
    }
}

/// What a window shows when the old host of a failed swap would not stop (#840 item 1).
pub(super) const STUCK_HOST: &str =
    "The previous host is still running and would not stop, so Retry cannot start it again until it ends. \"Restart completely\" ends it and everything it ran.";
