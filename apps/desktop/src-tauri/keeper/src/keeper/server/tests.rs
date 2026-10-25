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

/// #1501: the app's version is not compiled in, so a keeper running a built host must be told it,
/// and describes itself (`KeeperInfo`, the handoff hello) with what it was told
#[test]
fn a_built_host_needs_the_app_version_and_the_keeper_reports_it() {
    let argv = |extra: &[&str]| -> Vec<String> {
        ["centralu-keeper", "--data-dir", "/tmp/d"].iter().chain(extra).map(|s| s.to_string()).collect()
    };
    let host = ["--host-source", "/c/0.2.0-beta.4/host"];
    let mut o = parse_args(&argv(&host));
    o.host_source = Some(PathBuf::from(host[1]));
    assert!(missing_option(&o).is_some_and(|w| w.contains("--app-version")));
    o.app_version = Some(" ".into());
    assert!(missing_option(&o).is_some());
    o.app_version = Some("0.2.0-beta.4".into());
    assert_eq!(missing_option(&o), None);
    let dir = std::env::temp_dir();
    let info = KeeperInfo::of_this_process(&dir, own_build(&o));
    assert_eq!(info.version, "0.2.0-beta.4");
    assert_eq!(info.build.and_then(|b| b.version).as_deref(), Some("0.2.0-beta.4"));
    // Started by hand on the source host: nothing to be told, and it says the placeholder
    let mut by_hand = parse_args(&argv(&[]));
    by_hand.host_source = None;
    assert_eq!(missing_option(&by_hand), None);
    assert_eq!(KeeperInfo::of_this_process(&dir, own_build(&by_hand)).version, crate::keeper::DEV_VERSION);
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
        state: Mutex::new(State::new(BuildSource::dev(), Settings { background: true, ..Default::default() })),
        idle: Duration::from_secs(3600),
        started: Instant::now(),
        lock: File::create(data.join("keeper.lock")).unwrap(),
        frozen: AtomicBool::new(false),
        handed_over: AtomicBool::new(false),
        accept_parked: AtomicBool::new(false),
        requests: AtomicUsize::new(0),
    })
}

/// Pushes status until the window's writer gives up on it (it never reads), at most 10 s.
fn push_until_closed(k: &Arc<Keeper>) {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        {
            let Ok(mut st) = k.state.lock() else { break };
            if st.subscribers.is_empty() {
                break;
            }
            k.broadcast(&mut st);
        }
        thread::sleep(Duration::from_millis(1));
    }
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
    push_until_closed(&k);
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
    push_until_closed(&k);
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

/**
 * #840 item 1: a swap that failed while the old host would not stop could not start the previous
 * build again (its watcher still ran), and published nothing: the windows kept the old host's Ready
 * while the front door pointed nowhere. They are told the host failed now.
 */
#[test]
fn a_rollback_refused_while_the_old_host_runs_is_shown_as_failed() {
    use super::super::swap::tests::{deaf_host, until};
    let data = PathBuf::from(format!("/tmp/cck-rollback-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    let k = test_keeper(&data);
    assert!(k.sup.start(sink(&k), deaf_host(Default::default())));
    let ready = || matches!(k.state.lock().unwrap().status, HostStatus::Ready(_));
    assert!(until(Duration::from_secs(10), ready), "the host never said it was ready");
    start_again_after_failed_swap(&k, "the new build failed while taking over".into());
    let status = k.state.lock().unwrap().status.clone();
    k.sup.shutdown();
    let _ = fs::remove_dir_all(&data);
    let HostStatus::Failed { message } = status else { panic!("the windows still see {status:?}") };
    assert!(message.contains("Restart completely"), "the way out is not named: {message}");
}

/**
 * #840 item 5: a window that stops reading holds up no push. Pushes were blocking writes under the
 * state lock, so once its socket was full every change (and every request and the host's status,
 * which wait for that lock) waited out the write timeout. Another window still gets its status
 * meanwhile.
 */
#[test]
fn a_window_that_stops_reading_holds_up_no_push() {
    use std::io::{BufRead, BufReader};
    let data = PathBuf::from(format!("/tmp/cck-nonblock-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    let k = test_keeper(&data);
    let (stuck, keeper_end) = UnixStream::pair().unwrap();
    adopt_window(&k, keeper_end);
    let (reading, keeper_end) = UnixStream::pair().unwrap();
    adopt_window(&k, keeper_end);
    let got = Arc::new(AtomicUsize::new(0));
    {
        let got = got.clone();
        thread::spawn(move || {
            for line in BufReader::new(reading).lines() {
                if line.is_err() {
                    break;
                }
                got.fetch_add(1, Ordering::SeqCst);
            }
        });
    }
    let mut slowest = Duration::ZERO;
    for _ in 0..300 {
        let began = Instant::now();
        {
            let mut st = k.state.lock().unwrap();
            k.broadcast(&mut st);
        }
        slowest = slowest.max(began.elapsed());
        thread::sleep(Duration::from_millis(1));
    }
    let reached = got.load(Ordering::SeqCst);
    drop(stuck);
    let _ = fs::remove_dir_all(&data);
    assert!(slowest < WINDOW_WRITE_TIMEOUT / 2, "a push held the state lock for {slowest:?}");
    assert!(reached > 0, "the window that reads got no status");
}

/// #538: the front door's token reaches a host on its stdin when its bundle says it reads it there, and
/// in its environment only when it is a host from before (rolled back to, or switched to by hand).
#[test]
fn a_host_gets_the_token_on_stdin_unless_its_build_is_older_than_that() {
    let d = std::env::temp_dir().join(format!("cc-token-on-stdin-{}", std::process::id()));
    let (new, old) = (d.join("new"), d.join("old"));
    for dir in [&new, &old] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(new.join("bundle-info.json"), r#"{"commit":"a","protocolVersion":1,"hostProof":1,"tokenOnStdin":1}"#).unwrap();
    std::fs::write(old.join("bundle-info.json"), r#"{"commit":"b","protocolVersion":1,"hostProof":1}"#).unwrap();
    let launch = || HostLaunch { program: "node".into(), args: vec![], env: vec![], token: None };
    let said = std::cell::RefCell::new(Vec::<String>::new());
    let log = |m: &str| said.borrow_mut().push(m.to_string());

    for dir in [Some(new.as_path()), None] {
        let mut l = launch();
        host::hand_token("door-token", dir, &mut l, &log);
        assert_eq!(l.token, Some(host_proc::HandedToken("door-token".into())), "{dir:?}");
        assert!(l.env.contains(&("CC_HOST_TOKEN_ON_STDIN".into(), "1".into())), "{dir:?}");
        assert!(!l.env.iter().any(|(_, v)| v.contains("door-token")), "{dir:?}: not in the environment");
    }
    assert!(said.borrow().is_empty());

    let mut l = launch();
    host::hand_token("door-token", Some(&old), &mut l, &log);
    assert_eq!(l.token, None);
    assert!(l.env.contains(&("CC_HOST_TOKEN".into(), "door-token".into())), "an older host reads only its environment");
    assert!(said.borrow()[0].contains("older than #538"), "{:?}", said.borrow());
    let _ = std::fs::remove_dir_all(&d);
}

/// #1405: every op the dispatcher answers is in `OPS`, so the token test below sends it.
#[test]
fn ops_are_listed() {
    let src = include_str!("mod.rs");
    let body = &src[src.find("fn handle(k: Arc<Keeper>").unwrap()..];
    let body = &body[..body.find("\n}\n").unwrap()];
    let mut answered: Vec<String> = Vec::new();
    for line in body.lines().map(str::trim_start) {
        // `"op" =>`, `"a" | "b" if … =>`
        if !line.starts_with('"') || !line.contains("=>") {
            continue;
        }
        let arms = line.split("=>").next().unwrap().split(" if ").next().unwrap();
        for op in arms.split('|').map(|a| a.trim().trim_matches('"')) {
            if !answered.iter().any(|o| o == op) {
                answered.push(op.to_string());
            }
        }
    }
    let mut listed: Vec<String> = OPS.iter().map(|s| s.to_string()).collect();
    answered.sort();
    listed.sort();
    assert_eq!(answered, listed, "an op the dispatcher answers is missing from OPS, or OPS names one it no longer answers");
}

/// The front door's token as the keeper makes it (32 hex characters).
const DOOR_TOKEN: &str = "0123456789abcdef0123456789abcdef";

/// A keeper whose host is up behind the door.
fn keeper_with_a_host(data: &Path) -> Arc<Keeper> {
    let k = test_keeper(data);
    k.state.lock().unwrap().status = HostStatus::Ready(HostInfo { port: 4321, token: DOOR_TOKEN.into() });
    k
}

/// One request over `keeper.sock` from this process: the lines that come back, read until `want` of them have, the
/// keeper closes the connection, or 10 s pass (a bound for a stalled keeper, not a wait the test depends on).
fn ask(sock: &Path, req: &Value, want: usize) -> Vec<String> {
    use std::io::BufRead;
    let mut s = UnixStream::connect(sock).unwrap();
    s.write_all(&json_line(req)).unwrap();
    s.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    let mut r = BufReader::new(s.try_clone().unwrap());
    let mut lines = Vec::new();
    let end = Instant::now() + Duration::from_secs(10);
    let mut line = String::new();
    while lines.len() < want && Instant::now() < end {
        match r.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line.ends_with('\n') => lines.push(std::mem::take(&mut line)),
            // A timeout, or a line not whole yet: what was read stays in `line`, and the loop reads on
            _ => continue,
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/**
 * #1405, the test the design asks for: a process that is not a Centralu window (this test binary)
 * sends every op `keeper.sock` answers and reads every line that comes back, the pushed status of
 * an attach included, and none of them carries the front door's token. `status` and `attach` carry
 * the limited credential in its place; `switch` and `upgrade` are refused. `stop` (it ends this
 * process) and `restart` (it starts a host) are not sent: neither answer carries a view.
 */
#[test]
fn no_reply_carries_the_token_to_a_process_that_is_not_a_window() {
    let data = PathBuf::from(format!("/tmp/cck-token-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    let k = keeper_with_a_host(&data);
    let sock = k.sock.clone();
    {
        let k = k.clone();
        thread::spawn(move || accept_loop(&k));
    }
    let limited = limited::limited_token(DOOR_TOKEN);
    for op in OPS.iter().copied().filter(|op| !matches!(*op, "stop" | "restart")) {
        let req = match op {
            "attach" => json!({ "op": "attach", "protocol": KEEPER_PROTOCOL }),
            "set_background" => json!({ "op": "set_background", "on": true }),
            "switch" => json!({ "op": "switch", "source": { "commit": "abc" } }),
            "upgrade" => json!({ "op": "upgrade", "exe": "/tmp/centralu-keeper", "source": { "commit": "abc" } }),
            other => json!({ "op": other }),
        };
        // An attach stays open: push statuses to it until its two lines are read
        let pushing = Arc::new(AtomicBool::new(op == "attach"));
        if op == "attach" {
            let (k2, pushing) = (k.clone(), pushing.clone());
            thread::spawn(move || {
                while pushing.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(50));
                    if let Ok(mut st) = k2.state.lock() {
                        k2.broadcast(&mut st);
                    }
                }
            });
        }
        // Every other op is answered with one line and the connection closed: read to the end
        let lines = ask(&sock, &req, if op == "attach" { 2 } else { usize::MAX });
        pushing.store(false, Ordering::SeqCst);
        assert!(!lines.is_empty(), "{op} answered nothing");
        for line in &lines {
            assert!(!line.contains(DOOR_TOKEN), "{op} handed the token to a process that is not a window: {line}");
        }
        match op {
            "status" | "attach" => {
                let first: Value = serde_json::from_str(&lines[0]).unwrap();
                assert_eq!(first["view"]["status"]["token"], json!(limited), "{op}");
                assert_eq!(first["view"]["rights"], json!("limited"), "{op}");
                if op == "attach" {
                    assert!(lines.len() >= 2, "the attach got no pushed status to check");
                    let pushed: Value = serde_json::from_str(&lines[1]).unwrap();
                    assert_eq!(pushed["view"]["status"]["token"], json!(limited));
                }
            }
            "switch" | "upgrade" => assert!(lines[0].contains("window_only"), "{op}: {}", lines[0]),
            _ => {}
        }
    }
    let _ = fs::remove_dir_all(&data);
}

/// A window's view carries the token, and a push goes to each window in its own credential.
#[test]
fn a_window_gets_the_token_and_every_other_client_the_limited_credential() {
    let data = PathBuf::from(format!("/tmp/cck-rights-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).unwrap();
    let k = keeper_with_a_host(&data);
    let token = |v: &KeeperView| match &v.status {
        HostStatus::Ready(i) => i.token.clone(),
        _ => panic!("no host"),
    };
    {
        let st = k.state.lock().unwrap();
        assert_eq!(token(&k.view(&st, true)), DOOR_TOKEN);
        assert_eq!(k.view(&st, true).rights.as_deref(), Some("full"));
        assert_eq!(token(&k.view(&st, false)), limited::limited_token(DOOR_TOKEN));
    }
    // Two windows adopted from this process (neither is a window by its executable); one marked a
    // window as `Window::start` marks the app's own
    let (w1, k1) = UnixStream::pair().unwrap();
    let (w2, k2) = UnixStream::pair().unwrap();
    adopt_window(&k, k1);
    adopt_window(&k, k2);
    {
        let mut st = k.state.lock().unwrap();
        assert!(st.subscribers.iter().all(|w| !w.full), "a process that is not a window was taken for one");
        st.subscribers[0].full = true;
        k.broadcast(&mut st);
    }
    let read = |s: &UnixStream| {
        use std::io::BufRead;
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut line = String::new();
        BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
        line
    };
    assert!(read(&w1).contains(DOOR_TOKEN));
    let other = read(&w2);
    assert!(!other.contains(DOOR_TOKEN) && other.contains(&limited::limited_token(DOOR_TOKEN)));
    let _ = fs::remove_dir_all(&data);
}

/**
 * #1405, the other side: a process whose executable is the window's, by the exact path this keeper accepts (here the
 * window of the build it names, `bundle_path`), gets the front door's token; the same executable copied as `centralu`
 * anywhere else does not. This test binary, copied and run again to make the request, is both processes; the kernel
 * names its executable, as it names the window's. (A keeper with a team would also want the copy signed by it; no
 * keeper in a test has one.)
 */
#[test]
fn only_the_accepted_window_executable_gets_the_token() {
    const NAME: &str = "keeper::server::tests::only_the_accepted_window_executable_gets_the_token";
    // The copy, run again: it is the client
    if let Ok(sock) = std::env::var("CCK_TEST_CLIENT_SOCK") {
        let lines = ask(Path::new(&sock), &json!({ "op": "status" }), 1);
        // The harness writes its own words before this on the same line: the reader finds the marker anywhere
        println!("REPLY {}", lines.first().map(|l| l.trim()).unwrap_or(""));
        return;
    }
    let data = PathBuf::from(format!("/tmp/cck-named-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(data.join("elsewhere")).unwrap();
    let k = keeper_with_a_host(&data);
    let sock = k.sock.clone();
    {
        let k = k.clone();
        thread::spawn(move || accept_loop(&k));
    }
    let window = data.join("centralu");
    let renamed = data.join("elsewhere").join("centralu");
    for copy in [&window, &renamed] {
        fs::copy(std::env::current_exe().unwrap(), copy).unwrap();
    }
    // The build this keeper names is the window's: where no bundle is, its executable itself (`window_exe_of`)
    k.state.lock().unwrap().desired.bundle_path = Some(window.to_string_lossy().to_string());
    let status_of = |exe: &Path| -> Value {
        let out = std::process::Command::new(exe)
            .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
            .env("CCK_TEST_CLIENT_SOCK", &sock)
            .env_remove("CC_KEEPER_TEST_WINDOW_EXE")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let reply = stdout
            .lines()
            .find_map(|l| l.find("REPLY ").map(|at| l[at + 6..].to_string()))
            .unwrap_or_else(|| panic!("the copy made no request: {stdout}"));
        serde_json::from_str(&reply).unwrap()
    };
    let v = status_of(&window);
    assert_eq!(v["view"]["status"]["token"], json!(DOOR_TOKEN), "{v}");
    assert_eq!(v["view"]["rights"], json!("full"));
    // The same bytes, named `centralu`, at a path nothing accepts: a renamed `node` is this case
    let v = status_of(&renamed);
    assert_eq!(v["view"]["status"]["token"], json!(limited::limited_token(DOOR_TOKEN)), "{v}");
    assert_eq!(v["view"]["rights"], json!("limited"));
    let _ = fs::remove_dir_all(&data);
}
