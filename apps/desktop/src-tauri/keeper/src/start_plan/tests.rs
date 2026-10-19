use super::*;

const MAC: Os = Os::MacOs;
const LINUX: Os = Os::Linux;
const WIN: Os = Os::Windows;
const DEBUG: Build = Build::Debug;
const RELEASE: Build = Build::Release;

/// A window with nothing set: no variables, no bundled host, no keeper answering.
fn window(os: Os, build: Build) -> Facts {
    Facts {
        os,
        build,
        env: Env::default(),
        bundled_host: false,
        keeper_answering: false,
        shell: Shell::Untried,
        serve_launcher: false,
    }
}

/// A packaged app: the bundled host shipped.
fn packaged(os: Os) -> Facts {
    Facts { bundled_host: true, ..window(os, RELEASE) }
}

fn env(f: Facts, e: Env) -> Facts {
    Facts { env: e, ..f }
}

const USE_KEEPER: Env = Env { use_keeper: true, host_cmd: Var::Unset, keeper_host_source: Var::Unset, shell_unpinned: false };

/**
 * Every row of docs/agent-host.md §4.0, in the order the table lists them. Each row is what the code
 * did before this module existed (`use_keeper`, `shell_resources`, `bundled_host_dir`,
 * `direct_launcher`, `launch_keeper` and `exe::exec_target`), less the compatibility rows #461
 * removed; `the_plan_is_the_code_it_replaced` below checks every combination against a transcription
 * of that code.
 */
#[test]
fn every_row_of_the_start_table() {
    use Host::*;
    use StartMode::*;
    let shell = |allow_unpinned| ThroughShell { allow_unpinned };
    let rows: Vec<(&str, Facts, StartMode, Option<Host>, bool, Reason)> = vec![
        // macOS
        ("macOS release: through the shell", packaged(MAC), shell(false), Some(Bundle), false, Reason::MacRelease),
        (
            "macOS release, CC_SHELL_UNPINNED=1: through the shell, an unpinned one too",
            env(packaged(MAC), Env { shell_unpinned: true, ..Env::default() }),
            shell(true),
            Some(Bundle),
            false,
            Reason::MacRelease,
        ),
        (
            "macOS release, a keeper answering: attach",
            Facts { keeper_answering: true, ..packaged(MAC) },
            Attach,
            Some(Bundle),
            false,
            Reason::KeeperAnswers,
        ),
        (
            "macOS release after the shell fell back: the keeper beside the window",
            Facts { shell: Shell::FellBack, ..packaged(MAC) },
            KeeperBeside,
            Some(Bundle),
            false,
            Reason::ShellFellBack,
        ),
        (
            "macOS release, CC_KEEPER_HOST_SOURCE: the keeper beside the window, running that host",
            env(packaged(MAC), Env { keeper_host_source: Var::Set, ..Env::default() }),
            KeeperBeside,
            Some(Named),
            false,
            Reason::HostSourceNamed,
        ),
        (
            "macOS release, CC_KEEPER_HOST_SOURCE blank: no shell, the bundled host",
            env(packaged(MAC), Env { keeper_host_source: Var::Blank, ..Env::default() }),
            KeeperBeside,
            Some(Bundle),
            false,
            Reason::HostSourceNamed,
        ),
        (
            "macOS release with no bundled host: the keeper beside the window, the source host",
            Facts { bundled_host: false, ..packaged(MAC) },
            KeeperBeside,
            Some(Source),
            true,
            Reason::NoBundledHost,
        ),
        ("macOS debug: direct, the source host", window(MAC, DEBUG), Direct, Some(Source), true, Reason::DebugDirect),
        (
            "macOS debug ignores a bundled host left in target/debug",
            Facts { bundled_host: true, ..window(MAC, DEBUG) },
            Direct,
            Some(Source),
            true,
            Reason::DebugDirect,
        ),
        (
            "macOS debug, CC_USE_KEEPER=1: the keeper in the window's executable",
            env(window(MAC, DEBUG), USE_KEEPER),
            KeeperInProcess,
            Some(Source),
            true,
            Reason::DebugKeeper,
        ),
        (
            "macOS release, CC_HOST_CMD: direct, that command",
            env(packaged(MAC), Env { host_cmd: Var::Set, ..USE_KEEPER }),
            Direct,
            Some(Command),
            false,
            Reason::HostCommand,
        ),
        (
            "macOS release, CC_HOST_CMD blank: direct, the bundled host",
            env(packaged(MAC), Env { host_cmd: Var::Blank, ..Env::default() }),
            Direct,
            Some(Bundle),
            false,
            Reason::HostCommand,
        ),
        (
            "macOS debug, CC_HOST_CMD: direct, that command, the dev data folder",
            env(window(MAC, DEBUG), Env { host_cmd: Var::Set, ..Env::default() }),
            Direct,
            Some(Command),
            true,
            Reason::HostCommand,
        ),
        // Linux
        ("Linux release: direct, the bundled host", packaged(LINUX), Direct, Some(Bundle), false, Reason::KeeperOptIn),
        ("Linux debug: direct, the source host", window(LINUX, DEBUG), Direct, Some(Source), true, Reason::KeeperOptIn),
        (
            "Linux release, CC_USE_KEEPER=1: the keeper from the window's copy of it (no shell, FI4)",
            env(packaged(LINUX), USE_KEEPER),
            Keeper,
            Some(Bundle),
            false,
            Reason::NoShellHere,
        ),
        (
            "Linux debug, CC_USE_KEEPER=1: the keeper in the window's executable",
            env(window(LINUX, DEBUG), USE_KEEPER),
            KeeperInProcess,
            Some(Source),
            true,
            Reason::DebugKeeper,
        ),
        // Windows
        ("Windows release: direct, the bundled host", packaged(WIN), Direct, Some(Bundle), false, Reason::NoKeeperHere),
        ("Windows debug: direct, the source host", window(WIN, DEBUG), Direct, Some(Source), true, Reason::NoKeeperHere),
        (
            "Windows ignores CC_USE_KEEPER=1",
            env(packaged(WIN), USE_KEEPER),
            Direct,
            Some(Bundle),
            false,
            Reason::NoKeeperHere,
        ),
        (
            "Windows release, centralu serve installed in the data folder: the serve host, through its launcher (#1223)",
            Facts { serve_launcher: true, ..packaged(WIN) },
            Direct,
            Some(Serve),
            false,
            Reason::ServeInstalled,
        ),
        (
            "Windows debug with serve installed: the source host, in the dev data folder",
            Facts { serve_launcher: true, ..window(WIN, DEBUG) },
            Direct,
            Some(Source),
            true,
            Reason::NoKeeperHere,
        ),
        (
            "Windows release, CC_HOST_CMD with serve installed: that command",
            env(Facts { serve_launcher: true, ..packaged(WIN) }, Env { host_cmd: Var::Set, ..Env::default() }),
            Direct,
            Some(Command),
            false,
            Reason::HostCommand,
        ),
    ];
    for (name, facts, mode, host, dev, reason) in rows {
        let p = plan(&facts);
        assert_eq!((p.mode, p.host, p.dev, p.reason), (mode, host, dev, reason), "{name}");
        assert!(!p.reason.text().is_empty(), "{name}: a reason in words");
    }
}

/// What the window did before this module, written as it was. `centralu --keeper` decided too, until
/// #461 made it refuse unless a debug window asked (`keeper::exe::run_from_window`).
fn legacy(f: &Facts) -> (StartMode, Option<Host>, bool) {
    let release = f.build == Build::Release;
    // Added on purpose by #1223: a Windows release whose data folder has serve's launcher uses that host
    if f.os == Os::Windows && f.serve_launcher && release && f.bundled_host && f.env.host_cmd == Var::Unset {
        return (StartMode::Direct, Some(Host::Serve), false);
    }
    let unix = f.os != Os::Windows;
    let macos = f.os == Os::MacOs;
    // sidecar::use_keeper
    let use_keeper = (|| {
        if f.env.host_cmd != Var::Unset || !unix {
            return false;
        }
        let opted_in = f.env.use_keeper;
        if !macos {
            return opted_in;
        }
        release || opted_in
    })();
    // sidecar::bundled_host_dir
    let bundled = release && f.bundled_host;
    if !use_keeper {
        // sidecar::direct_launcher
        let host = if f.env.host_cmd == Var::Set {
            Host::Command
        } else if bundled {
            Host::Bundle
        } else {
            Host::Source
        };
        return (StartMode::Direct, Some(host), !bundled);
    }
    // KeeperLink::new
    let dev = !bundled;
    let host = if f.env.keeper_host_source == Var::Set {
        Host::Named
    } else if bundled {
        Host::Bundle
    } else {
        Host::Source
    };
    // client::ensure: a keeper answering is attached to, and nothing is launched
    if f.keeper_answering {
        return (StartMode::Attach, Some(host), dev);
    }
    // sidecar::shell_resources, filtered by `!dev` in KeeperLink::new, and `shell_off`
    let shell_resources = macos && release && f.env.keeper_host_source == Var::Unset && !dev;
    if shell_resources && f.shell == Shell::Untried {
        return (StartMode::ThroughShell { allow_unpinned: f.env.shell_unpinned }, Some(host), dev);
    }
    // KeeperLink::launch_keeper: a debug build starts itself in-process, else `exe::to_start`, which
    // fell back to the window's own executable when no `centralu-keeper` was beside it. Changed on
    // purpose by #461: that bundle now fails to start its keeper, and says so.
    let mode = if !release {
        StartMode::KeeperInProcess
    } else if !macos {
        // Changed on purpose by runtime-unification step 4: a Linux window copies the keeper out of
        // its AppImage and starts it from the copy (FI4).
        StartMode::Keeper
    } else {
        StartMode::KeeperBeside
    };
    (mode, Some(host), dev)
}

/// Every combination of every fact, against `legacy`: the plan changed where the decision lives,
/// not what it decides.
#[test]
fn the_plan_is_the_code_it_replaced() {
    let vars = [Var::Unset, Var::Blank, Var::Set];
    let mut n = 0;
    for os in [MAC, LINUX, WIN] {
        for build in [DEBUG, RELEASE] {
            for host_cmd in vars {
                for keeper_host_source in vars {
                    // The six yes-or-no facts, one bit each
                    for bits in 0u32..(1 << 6) {
                        let bit = |i: u32| bits & (1 << i) != 0;
                        let f = Facts {
                            os,
                            build,
                            env: Env { host_cmd, use_keeper: bit(0), keeper_host_source, shell_unpinned: bit(1) },
                            bundled_host: bit(2),
                            keeper_answering: bit(3),
                            shell: if bit(4) { Shell::FellBack } else { Shell::Untried },
                            serve_launcher: bit(5),
                        };
                        let p = plan(&f);
                        assert_eq!((p.mode, p.host, p.dev), legacy(&f), "{f:?}");
                        n += 1;
                    }
                }
            }
        }
    }
    assert_eq!(n, 3 * 2 * 3 * 3 * 64);
}

/// Only macOS's release signs content (`scripts/release-npm.mts`). A Linux keeper from a copy its
/// window made hands over to the copy the next window names; a macOS one never does (`content.rs`).
#[test]
fn only_the_macos_release_signs_content() {
    assert!(MAC.signs_content());
    assert!(!LINUX.signs_content());
    assert!(!WIN.signs_content());
}
