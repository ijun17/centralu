use super::*;

#[test]
fn reads_the_options_the_app_passes() {
    let args: Vec<String> = [
        "centralu",
        "--keeper",
        "--data-dir",
        "/tmp/d",
        "--host-source",
        "/A.app/Contents/Resources/resources/host",
        "--bundle-path",
        "/A.app",
        "--app-version",
        "0.1.0",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let o = parse_args(&args);
    assert_eq!(o.data_dir, Some(PathBuf::from("/tmp/d")));
    assert_eq!(o.bundle_path.as_deref(), Some("/A.app"));
    assert_eq!(o.app_version.as_deref(), Some("0.1.0"));
    if std::env::var("CC_KEEPER_HOST_SOURCE").is_err() {
        assert_eq!(o.host_source, Some(PathBuf::from("/A.app/Contents/Resources/resources/host")));
    }
}

/// Step 5: only a keeper running from verified content takes the new build's content; one
/// started directly hands over to the `centralu-keeper` it is given, exactly as before (a debug
/// build, Linux, the window's fallback, a keeper of #444).
#[test]
fn a_switch_takes_signed_content_only_from_a_keeper_in_verified_content() {
    let content = content::Origin::Content { dir: PathBuf::from("/d/content/0.2.0"), version: "0.2.0".into(), signed: true };
    // A Linux window's own copy is not signed: its keeper hands over to the copy the next window
    // made and names, never refusing for want of a signature no Linux release has (FI4).
    let unsigned = content::Origin::Content { dir: PathBuf::from("/d/content/0.2.0"), version: "0.2.0".into(), signed: false };
    let next = Path::new("/d/content/0.2.1/centralu-keeper");
    assert_eq!(content_route(&unsigned, Some(next), None), None);
    // Where the release signs content, a folder without a signature changes nothing
    assert_eq!(content_route(&unsigned.clone().requiring_signature(true), Some(next), None), Some(None));
    let exe = Path::new("/Applications/Centralu.app/Contents/MacOS/centralu-keeper");
    let carried = PathBuf::from("/Applications/Centralu.app/Contents/Resources/content");
    assert_eq!(content_route(&content::Origin::Direct, Some(exe), Some("/Applications/Centralu.app")), None);
    assert_eq!(content_route(&content::Origin::Direct, None, None), None);
    assert_eq!(content_route(&content, Some(exe), None), Some(Some(carried.clone())));
    // A window from before #440 named its own executable: that names no content (#461), only
    // the bundle path it sends with it does
    let window = Path::new("/Applications/Centralu.app/Contents/MacOS/centralu");
    assert_eq!(content_route(&content, Some(window), None), Some(None));
    assert_eq!(content_route(&content, Some(window), Some("/Applications/Centralu.app")), Some(Some(carried.clone())));
    // A window that names no executable: its bundle
    assert_eq!(content_route(&content, None, Some("/Applications/Centralu.app")), Some(Some(carried)));
    // Nothing to take content from: refused later, never a direct handoff
    assert_eq!(content_route(&content, Some(Path::new("/tmp/build/centralu-keeper")), None), Some(None));
    assert_eq!(content_route(&content, None, None), Some(None));
}

/// What the cleanup must leave: the running host's folder, the next launch's, and while a switch
/// runs, its target, which a failed handoff's host swap claims only once its thread runs.
#[test]
fn the_folders_in_use_are_the_running_the_next_and_a_running_switchs_target() {
    let b = |dir: &str| BuildSource { commit: dir.into(), host_dir: Some(format!("/d/content/{dir}/host")), ..Default::default() };
    let mut st = State {
        source: Some(BuildSource { copy_dir: Some("/d/hosts/abc".into()), ..b("0.2.0") }),
        swap: Some(SwapView::begun(Phase::HandingOver, b("0.2.1"), None)),
        swapping: true,
        ..State::new(b("0.2.0"), Settings::default())
    };
    let dirs = |st: &State| host_dirs_in_use(st).into_iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert_eq!(dirs(&st), ["/d/hosts/abc", "/d/content/0.2.0/host", "/d/content/0.2.0/host", "/d/content/0.2.1/host"]);
    st.swapping = false;
    assert!(!dirs(&st).contains(&"/d/content/0.2.1/host".to_string()), "a switch that ended holds nothing");
}

/// A keeper with nothing running, for tests of what it does with its windows.
fn test_keeper(data: &Path) -> Arc<Keeper> {
    let sock = data.join("keeper.sock");
    let _ = fs::remove_file(&sock);
    Arc::new(Keeper {
        origin: content::Origin::Direct,
        info: KeeperInfo::of_this_process(data, BuildSource::dev()),
        listener: UnixListener::bind(&sock).unwrap(),
        sock,
        data: data.to_path_buf(),
        sup: Supervisor::new(),
        door: FrontDoor::open(0, "t".into()).unwrap(),
        children: Children::disabled(),
        copies: source::Copies::new(data, None),
        // Background on: a window leaving does not stop the test's process.
        state: Mutex::new(State::new(BuildSource::dev(), Settings { background: true })),
        idle: Duration::from_secs(3600),
        started: Instant::now(),
        lock: File::create(data.join("keeper.lock")).unwrap(),
        frozen: AtomicBool::new(false),
        handed_over: AtomicBool::new(false),
        accept_parked: AtomicBool::new(false),
        requests: AtomicUsize::new(0),
    })
}

/**
 * #840 item 5: a window the keeper can no longer push its status to (it stopped reading) was
 * taken off the push list and nothing else: its connection stayed open, so it still counted as
 * attached (background mode off never stopped the keeper for it) and the window, if it came
 * back, waited for status that never came. The keeper now closes that connection, which is the
 * detach, and the window attaches again.
 */
#[test]
fn a_window_whose_status_push_fails_is_closed_and_detached() {
    let data = PathBuf::from(format!("/tmp/cck-push-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    let k = test_keeper(&data);
    let (window, keeper_end) = UnixStream::pair().unwrap();
    adopt_window(&k, keeper_end);
    assert_eq!(k.state.lock().unwrap().attached, 1);
    // The window stops reading and never closes its own end: pushes fill its socket until one
    // times out.
    for _ in 0..1000 {
        let Ok(mut st) = k.state.lock() else { break };
        if st.subscribers.is_empty() {
            break;
        }
        k.broadcast(&mut st);
    }
    let end = Instant::now() + Duration::from_secs(3);
    while k.state.lock().unwrap().attached > 0 && Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(k.state.lock().unwrap().attached, 0, "the window still counts as attached");
    assert!(k.state.lock().unwrap().subscribers.is_empty());
    drop(window);
    let _ = fs::remove_dir_all(&data);
}

/**
 * #840 item 5, the review's catch: with background mode off (the default), the window the
 * keeper closed was its last, and its detach stopped the keeper at once, host, agents and
 * terminals with it. A window that was only stalled then came back to a new keeper with
 * nothing. It is waited for now, as an announced relaunch is, and the next attach spends that.
 *
 * Run in a process of its own: without the grace the keeper's stop ends the process.
 */
#[test]
fn a_closed_window_is_waited_for_with_background_mode_off() {
    if super::super::accept::few_descriptors::rerun("keeper::server::tests::a_closed_window_is_waited_for_with_background_mode_off").is_some() {
        return;
    }
    let data = PathBuf::from(format!("/tmp/cck-regrace-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    let k = test_keeper(&data);
    k.state.lock().unwrap().settings.background = false;
    let (window, keeper_end) = UnixStream::pair().unwrap();
    adopt_window(&k, keeper_end);
    for _ in 0..1000 {
        let Ok(mut st) = k.state.lock() else { break };
        if st.subscribers.is_empty() {
            break;
        }
        k.broadcast(&mut st);
    }
    let end = Instant::now() + Duration::from_secs(3);
    while k.state.lock().unwrap().attached > 0 && Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
    thread::sleep(Duration::from_millis(300));
    let st = k.state.lock().unwrap();
    assert_eq!(st.attached, 0, "the window was closed");
    assert!(!st.stopping, "the keeper stopped for the window it closed itself");
    assert!(st.reattaching(Instant::now()), "it waits for the window to attach again");
    drop(st);
    let (again, keeper_end) = UnixStream::pair().unwrap();
    adopt_window(&k, keeper_end);
    assert!(k.state.lock().unwrap().reattach_until.is_none(), "a window back spends the grace");
    // Its leaving would be an ordinary last detach, which stops this process: it stays.
    std::mem::forget(again);
    drop(window);
    let _ = fs::remove_dir_all(&data);
}
