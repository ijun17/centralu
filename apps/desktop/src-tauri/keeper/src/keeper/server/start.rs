//! Starting a keeper: its options, the lock on the data folder, its sockets and its first host.

use super::*;

/// Command-line options. The app passes all of them; a person starting a keeper by hand can
/// leave them out (it then runs the host from source, as a debug build would).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Options {
    pub data_dir: Option<PathBuf>,
    pub host_source: Option<PathBuf>,
    pub bundle_path: Option<String>,
    pub app_version: Option<String>,
    /// Started by a keeper of an earlier build to take over from it (#280 step 4). This build takes no keeper over (#1895
    /// step 4, PR 4): it exits at once (`EXIT_NO_TAKE_OVER`), and that keeper rolls back and serves on.
    pub take_over_fd: Option<i32>,
}

pub fn parse_args(args: &[String]) -> Options {
    let mut o = Options::default();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--data-dir" => o.data_dir = it.next().map(PathBuf::from),
            "--host-source" => o.host_source = it.next().map(PathBuf::from),
            "--bundle-path" => o.bundle_path = it.next().cloned(),
            "--app-version" => o.app_version = it.next().cloned(),
            "--take-over-fd" => o.take_over_fd = it.next().and_then(|s| s.parse().ok()),
            // Ignored, like anything unknown. `--keeper` among them: every start passed it until
            // #461, and shell v1, whose bytes are pinned, still does.
            _ => {}
        }
    }
    // The integration test points a keeper at the repository's freshly bundled host this way.
    if let Ok(p) = std::env::var("CC_KEEPER_HOST_SOURCE") {
        if !p.trim().is_empty() {
            o.host_source = Some(PathBuf::from(p));
        }
    }
    o
}

/// The build this keeper's executable is from, as the options name it (`--host-source`, `--app-version`).
pub(in crate::keeper) fn own_build(o: &Options) -> BuildSource {
    match &o.host_source {
        Some(dir) => BuildSource::from_host_dir(dir, o.bundle_path.clone(), o.app_version.clone()),
        None => BuildSource::dev(),
    }
}

/// Why these options cannot start a keeper, or None. A built host (`--host-source`) needs the app's
/// version (`--app-version`): git holds none, so nothing compiled in can stand for it (#1501), and the
/// content folder and the build record are named after it. Every starter passes it: the window and the shell
/// (`exe::Start`).
pub(in crate::keeper) fn missing_option(o: &Options) -> Option<&'static str> {
    (o.host_source.is_some() && o.app_version.as_deref().is_none_or(|v| v.trim().is_empty()))
        .then_some("--host-source without --app-version: the app's version is not compiled in, so a keeper running a built host must be told it")
}

/// The exit code of a keeper started with options it cannot run with (`missing_option`), told apart
/// from 1 (could not start) and 3 (another keeper holds the folder)
pub(in crate::keeper) const EXIT_USAGE: i32 = 2;

/// The exit code of a keeper an earlier build's keeper started to take over from it: the code that keeper's handoff reads
/// as "the new keeper gave the handoff up" (its `EXIT_ABORTED`), after which it rolls back and serves on
pub(in crate::keeper) const EXIT_NO_TAKE_OVER: i32 = 7;

/// The keeper's entry point. Returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let opts = parse_args(args);
    // Started to take an earlier build's keeper over: nothing here can, and that keeper still holds everything
    if opts.take_over_fd.is_some() {
        log("started to take over from another keeper, which this build no longer does (#1895 step 4); leaving everything to it");
        return EXIT_NO_TAKE_OVER;
    }
    // Before anything opens a descriptor
    let raised = os::raise_descriptor_limit();
    let data = opts.data_dir.clone().unwrap_or_else(super::data_dir);
    // From content nothing runs from an AppImage's mount any more: let it go before anything else
    // opens a descriptor or starts a thread (FI4, FI5, `appimage.rs`).
    let shed = content::own_origin(&data).dir().is_some().then(super::appimage::shed);
    if let Some(what) = &shed {
        log(what);
    }
    if let Some((from, to)) = raised {
        log(&format!("descriptor limit raised from {from} to {to}"));
    }
    if let Some(why) = missing_option(&opts) {
        log(&format!("not starting: {why}"));
        return EXIT_USAGE;
    }
    // Before anything creates the folder: the host leaves a legacy folder alone once the new one
    // exists, so creating it first would strand the person's data (data-dir.ts).
    if let Some((from, to)) = super::prepare_default_dir(&data, std::env::var("CC_DEV").as_deref() == Ok("1")) {
        log(&format!("data folder moved: {} -> {}", from.display(), to.display()));
    }
    if let Err(e) = fs::create_dir_all(&data) {
        log(&format!("cannot create the data folder {}: {e}", data.display()));
        return 1;
    }
    let sock = socket_path(&data);

    // One keeper per data folder.
    let lock = match OpenOptions::new().create(true).read(true).write(true).mode(0o600).open(data.join("keeper.lock")) {
        Ok(f) => f,
        Err(e) => {
            log(&format!("cannot open keeper.lock: {e}"));
            return 1;
        }
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match os::try_lock(&lock) {
            Ok(true) => break,
            Ok(false) => {}
            Err(e) => {
                log(&format!("cannot lock keeper.lock: {e}"));
                return 1;
            }
        }
        // Someone holds it. If it answers, it is the keeper: defer to it and start no host.
        if let Ok(v) = client::request(&sock, &json!({ "op": "status" }), Duration::from_secs(2)) {
            let pid = v.pointer("/view/keeper/pid").and_then(Value::as_u64).unwrap_or(0);
            log(&format!("another keeper (pid {pid}) already holds {}; leaving the host to it", data.display()));
            return EXIT_ALREADY_RUNNING;
        }
        // Held but silent: a keeper on its way out (it removes its socket first) or on its way
        // in (it binds right after locking). Either way the answer is seconds away.
        if Instant::now() >= deadline {
            log("keeper.lock is held by a keeper that does not answer; giving up after 15s");
            return 4;
        }
        thread::sleep(Duration::from_millis(200));
    }
    record_lock_holder(&lock);

    // A socket left by a keeper that died is ours to replace: we hold the lock.
    let _ = fs::remove_file(&sock);
    let listener = match os::with_umask(0o077, || UnixListener::bind(&sock)) {
        Ok(l) => l,
        Err(e) => {
            // The usual cause is a path over the 104-byte limit for unix sockets.
            log(&format!("cannot listen on {}: {e}", sock.display()));
            return 5;
        }
    };
    let _ = fs::set_permissions(&sock, fs::Permissions::from_mode(0o600));

    // A child socket a keeper of beta.48 or older left when it died: no host may take it for a live service (agent-host
    // `lifecycle/keeper-held.ts`). The host spawns its own children, and an update stops them and continues their turns
    let _ = fs::remove_file(data.join("children.sock"));

    let desired = own_build(&opts);
    let settings = source::load_settings(&data);
    // The front door: one port and one token for this keeper's whole life (front_door.rs)
    let door = match front_door::new_token().and_then(|t| FrontDoor::open(0, t)) {
        Ok(d) => d,
        Err(e) => {
            log(&format!("cannot open the front door: {e}"));
            return 6;
        }
    };
    let origin = content::own_origin(&data);
    let copies = source::Copies::new(&data, origin.dir().map(Path::to_path_buf));
    let keeper = Arc::new(Keeper {
        origin,
        info: KeeperInfo::of_this_process(&data, desired.clone()),
        data,
        sock,
        sup: Supervisor::new(),
        door,
        copies,
        state: Mutex::new(State::new(desired, settings)),
        idle: idle_limit(),
        started: Instant::now(),
        _lock: lock,
        listener,
    });
    log(&format!(
        "keeper {} started (pid {}, data {}, front door {}, background {}, idle limit {}s)",
        keeper.info.version,
        keeper.info.pid,
        keeper.data.display(),
        keeper.door.url(),
        keeper.state.lock().map(|s| s.settings.background).unwrap_or(false),
        keeper.idle.as_secs()
    ));
    log_origin(&keeper.origin);

    keeper.sup.start(sink(&keeper), launcher(&keeper));
    serve(keeper)
}

/// Says in the log where this keeper runs from.
fn log_origin(origin: &content::Origin) {
    if let content::Origin::Content { dir, signed: false, .. } = origin {
        log(&format!("running from the copy {} a window made", dir.display()));
    } else if let content::Origin::Content { dir, .. } = origin {
        log(&format!("running from verified content {}", dir.display()));
    }
}

/// Writes our pid into the lock file — a description of the holder for someone reading it,
/// not the lock itself (the flock is). From the start of the file.
fn record_lock_holder(mut lock: &File) {
    let _ = lock.set_len(0);
    let _ = lock.seek(std::io::SeekFrom::Start(0));
    let _ = writeln!(lock, "{}", std::process::id());
}
