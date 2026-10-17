//! Finding the Node that runs the bundled host: the rule, the cache and the candidate lists of
//! every OS. Which list, which first look and which hint apply here is decided by
//! `start_plan::Os::current`; the lists themselves are plain data, so their tests run on any OS.

use std::path::Path;
use std::process::{Command, Stdio};

use super::hide_console;
use crate::os;
use crate::start_plan::Os;

/// Told to someone who has no Node at all, so it has to name a command they can actually
/// run. `brew` was hardcoded, which on Linux points at a package manager that is not
/// there — the one message whose whole job is to unblock a stuck user would have sent
/// them somewhere else.
pub(super) fn install_node_hint(os: Os) -> &'static str {
    match os {
        Os::MacOs => "`brew install node`",
        Os::Linux => "your distribution's package manager (for example, `apt install nodejs`)",
        Os::Windows => "`winget install OpenJS.NodeJS.LTS`",
    }
}

pub(super) fn upgrade_node_hint(os: Os) -> &'static str {
    match os {
        Os::MacOs => "`brew upgrade node`",
        Os::Linux => "your distribution's package manager",
        Os::Windows => "`winget upgrade OpenJS.NodeJS.LTS`",
    }
}

/// The first place `pick_node` asks, named in the "looked in" list.
pub(super) fn first_look(os: Os) -> &'static str {
    match os {
        Os::Windows => "PATH",
        Os::MacOs | Os::Linux => "login shell PATH",
    }
}

/// The first look itself: the login shell on unix; on Windows, PATH as Explorer handed it over.
fn probe_first() -> Option<String> {
    match Os::current() {
        Os::Windows => {
            let path = std::env::var_os("PATH")?;
            first_on_path(std::env::split_paths(&path), "node.exe", |p| p.is_file())
        }
        Os::MacOs | Os::Linux => os::probe_login_shell(),
    }
}

/// The fallback for when the first look finds nothing: where installers and version managers put
/// Node.
fn fallback_node_paths() -> Vec<String> {
    match Os::current() {
        Os::Windows => windows_node_paths(|name| std::env::var(name).ok().filter(|v| !v.is_empty()), nvm_windows_versions),
        Os::MacOs | Os::Linux => node_paths_under(&std::env::var("HOME").unwrap_or_default()),
    }
}

/// nvm-windows' version folders (`v22.3.1`), newest first, compared as numbers.
fn nvm_windows_versions(home: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    let mut versions: Vec<(Vec<u32>, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let parts = version_parts(&name);
            (name.starts_with('v') && !parts.is_empty()).then_some((parts, name))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, n)| n).collect()
}

/// The guidance shown to the person verbatim when Node cannot be found.
///
/// **A silent failure is the worst outcome.** It used to just run `"node"` bare when it
/// could not find it, which left only `No such file or directory`, and that raw text is
/// what showed up on screen. There was no way to tell apart Node truly being missing, Node
/// being present but not found, and the version being too low.
pub(super) fn node_missing_message(looked: &[String]) -> String {
    format!(
        "Could not find Node.js. Centralu requires {}.\n\
         Check with `node --version` in a terminal, and if it is missing, install it with \
         {} or from https://nodejs.org, then restart the app.\n\
         Looked in: {}",
        min_node().map_or_else(|_| "a newer Node".to_string(), |f| format!("Node {} or newer", floor_text(f))),
        install_node_hint(Os::current()),
        looked.join(", ")
    )
}

/// The npm package's own manifest, read at compile time: its `engines.node` is the one place the
/// floor lives (#699). The launcher and the hub read the same value, and a change to the file
/// rebuilds this crate.
const LAUNCHER_PACKAGE: &str = include_str!("../../../../../../packaging/npm/centralu/package.json");

/// The oldest Node the host runs on, `[major, minor, patch]`, from `engines.node` (`>=22.14.0`).
///
/// The bundled database module declares Node-API 10, which Node has from 22.14.0; under 22.12.0 it
/// loads and then crashes on its first use, before the host logs a line (#699). The host bundle's
/// esbuild target is node22 as well, so below 22 even the syntax breaks.
///
/// Read once. An `engines.node` that is not a plain floor is an `Err` with a sentence naming it, never
/// a panic: this runs on the supervisor's watcher thread, where a panic would leave the window on
/// "Starting" with no reason. `the_floor_is_the_npm_packages_engines_and_nothing_else` fails in CI
/// before such a package.json can ship.
pub(super) fn min_node() -> Result<[u32; 3], String> {
    static FLOOR: std::sync::OnceLock<Result<[u32; 3], String>> = std::sync::OnceLock::new();
    FLOOR.get_or_init(|| read_floor(LAUNCHER_PACKAGE)).clone()
}

/// `min_node` for a given manifest text
pub(super) fn read_floor(manifest: &str) -> Result<[u32; 3], String> {
    let bad = |what: String| format!("Centralu cannot tell which Node it needs: {what}; reinstall Centralu.");
    let manifest: serde_json::Value = serde_json::from_str(manifest).map_err(|e| bad(format!("its package.json is not JSON ({e})")))?;
    let range = manifest["engines"]["node"].as_str().ok_or_else(|| bad("its package.json has no engines.node".into()))?;
    floor_of(range).ok_or_else(|| bad(format!("engines.node is {range:?}, not a plain floor like \">=22.14.0\"")))
}

/// `>=22.14.0` or `>=22.14` → `[22, 14, 0]`; None for any other shape of range
pub(super) fn floor_of(range: &str) -> Option<[u32; 3]> {
    let rest = range.trim().strip_prefix(">=")?.trim();
    let parts: Vec<u32> = rest.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    match parts[..] {
        [a, b] => Some([a, b, 0]),
        [a, b, c] => Some([a, b, c]),
        _ => None,
    }
}

/// The floor as the person reads it: `22.14.0`
pub(super) fn floor_text(floor: [u32; 3]) -> String {
    floor.map(|n| n.to_string()).join(".")
}

/**
 * Whether a version (`v22.12.0`, as `node --version` prints it) is older than `floor`, by the rule of the
 * hub's and the launcher's `belowFloor` (`agent-host/src/links/node-floor.ts`, `packaging/npm/centralu/bin/
 * node-floor.mjs`), which `tooling/fixtures/node-floor.json` pins for all three: a version that does not
 * start with three numbers gives no basis to refuse and is let through (`v22`, `v22.x.1`), build metadata
 * is ignored, and a prerelease of the floor is below it (`v22.14.0-rc.1`), as SemVer orders them.
 */
pub(super) fn below_floor(found: &str, floor: [u32; 3]) -> bool {
    let v = found.trim();
    let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mut lead = v.splitn(3, '.');
    let (Some(a), Some(b), Some(c)) = (lead.next(), lead.next(), lead.next()) else { return false };
    if !digits(a) || !digits(b) || !c.starts_with(|ch: char| ch.is_ascii_digit()) {
        return false;
    }
    let v = v.split('+').next().unwrap_or(v);
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    let mut parts = core.split('.');
    for x in floor {
        // A part that is not a number (`0abc`) ends the comparison as "not older", as the hub's does
        let Some(y) = parts.next().map(|p| if digits(p) { p.parse::<u64>().ok() } else { None }).unwrap_or(Some(0)) else {
            return false;
        };
        if u64::from(x) != y {
            return u64::from(x) > y;
        }
    }
    pre.is_some()
}

/// Finding Node takes around one second because it launches the whole login shell. Since the
/// restart loop calls this every time, a successful find is cached. **A failed find is never
/// cached** (#184) — someone who installs Node after opening the app and presses Retry must
/// not be shown the old "not found" again.
static NODE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Finds the **absolute path** to the Node the release build will use to run the host.
///
/// **Why a fixed path does not work (measured):** a `.app` launched from the GUI does not
/// inherit the login shell's PATH, and only gets
/// `/usr/bin:/bin:/usr/sbin:/sbin`. This used to only check the two Homebrew locations and
/// `/usr/bin`, but Node installed via nvm, mise or volta lives under the home directory, so
/// **the app would not start even on a Mac where Node was perfectly well installed.** The
/// claude and codex CLI lookups had already hit the same problem and were fixed to ask the
/// login shell (`packages/agent-host/src/env-path.ts`); only node was left using the old
/// approach.
///
/// **Windows** has no login shell to ask, and does not need one: a program started from Explorer
/// inherits the user's PATH from the registry, which is where the Node installer, nvm-windows,
/// Volta and Scoop put themselves. So PATH is searched first, then the places those installers use.
pub fn resolve_node() -> Result<String, String> {
    remember_found(&NODE, || pick_node(probe_first(), fallback_node_paths()))
}

/// The first `<dir>\<name>` that exists, over the absolute entries of PATH only: a relative entry
/// would be resolved against whatever the working directory happens to be.
pub(super) fn first_on_path(
    dirs: impl IntoIterator<Item = std::path::PathBuf>,
    name: &str,
    exists: impl Fn(&Path) -> bool,
) -> Option<String> {
    dirs.into_iter()
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| exists(p))
        .map(|p| p.to_string_lossy().to_string())
}

/// Only caches a successful find. If it was not found, asks again next time.
pub(super) fn remember_found(
    cache: &std::sync::OnceLock<String>,
    probe: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(found) = cache.get() {
        return Ok(found.clone());
    }
    let found = probe()?;
    Ok(cache.get_or_init(|| found).clone())
}

/// The selection rule pulled out on its own, so it can be tested with neither a shell nor a
/// real filesystem.
///
/// Order: whatever the login shell knows about (the exact node the person already uses in a
/// terminal), then the common install locations. **Does not stop just because it is old** — a
/// Mac with nvm defaulting to v18 while Homebrew has v22 is common. But it carries forward the
/// fact that it hit an old one, and shows that as the reason if nothing newer turns up
/// ("needs an upgrade" is closer to what the person actually has to do than "not found").
pub(super) fn pick_node(from_shell: Option<String>, fallbacks: Vec<String>) -> Result<String, String> {
    let mut looked = vec![first_look(Os::current()).to_string()];
    let mut ordered: Vec<String> = from_shell.into_iter().collect();

    for candidate in fallbacks {
        looked.push(candidate.clone());
        if Path::new(&candidate).exists() {
            ordered.push(candidate);
        }
    }

    let mut too_old: Option<String> = None;
    for path in ordered {
        match check_node_version(&path) {
            Ok(found) => return Ok(found),
            Err(why) => {
                too_old.get_or_insert(why);
            }
        }
    }

    Err(too_old.unwrap_or_else(|| node_missing_message(&looked)))
}

/// Where Windows installers put `node.exe`, read from the environment variables they set.
///
/// Built with `\` by hand rather than `Path::join`, so the list is the same string on every OS
/// and its test runs anywhere. `versions` lists nvm-windows' installed versions, newest first.
pub(super) fn windows_node_paths(env: impl Fn(&str) -> Option<String>, versions: impl Fn(&str) -> Vec<String>) -> Vec<String> {
    let mut paths = Vec::new();
    // The official installer (Chocolatey and winget wrap it), machine-wide.
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(dir) = env(var) {
            paths.push(format!("{dir}\\nodejs\\node.exe"));
        }
    }
    if let Some(local) = env("LOCALAPPDATA") {
        // A per-user install of the same.
        paths.push(format!("{local}\\Programs\\nodejs\\node.exe"));
        // Volta's per-user shims.
        paths.push(format!("{local}\\Volta\\bin\\node.exe"));
    }
    // nvm-windows: the active version is a symlink at NVM_SYMLINK; every version sits in NVM_HOME.
    if let Some(link) = env("NVM_SYMLINK") {
        paths.push(format!("{link}\\node.exe"));
    }
    if let Some(home) = env("NVM_HOME") {
        paths.extend(versions(&home).into_iter().map(|v| format!("{home}\\{v}\\node.exe")));
    }
    if let Some(profile) = env("USERPROFILE") {
        paths.push(format!("{profile}\\scoop\\shims\\node.exe"));
        paths.push(format!("{profile}\\scoop\\apps\\nodejs\\current\\node.exe"));
        paths.push(format!("{profile}\\scoop\\apps\\nodejs-lts\\current\\node.exe"));
    }
    // ProgramFiles and ProgramW6432 are usually the same folder; Windows paths ignore case.
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.to_ascii_lowercase()));
    paths
}

pub(super) fn node_paths_under(home: &str) -> Vec<String> {
    let mut paths = vec![
        "/opt/homebrew/bin/node".to_string(),
        "/usr/local/bin/node".to_string(),
        "/opt/local/bin/node".to_string(),
        "/usr/bin/node".to_string(),
    ];
    if !home.is_empty() {
        paths.push(format!("{home}/.volta/bin/node"));
        paths.push(format!("{home}/.local/share/mise/shims/node"));
        paths.push(format!("{home}/.asdf/shims/node"));
        paths.push(format!("{home}/.local/bin/node"));
        // nvm keeps a separate directory per version — pick the highest one.
        paths.extend(nvm_versions(&format!("{home}/.nvm/versions/node")));
    }
    paths
}

/// `~/.nvm/versions/node/*/bin/node`, in descending version order.
///
/// The names look like `v22.3.1`, so a lexical sort would wrongly put v9 ahead of v22.
/// Compared as numbers instead.
pub(super) fn nvm_versions(root: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<(Vec<u32>, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let parts = version_parts(&name);
            (!parts.is_empty()).then(|| (parts, format!("{root}/{name}/bin/node")))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, p)| p).collect()
}

/// `v22.3.1` → `[22, 3, 1]`. An empty vector if it does not parse as numbers.
pub(super) fn version_parts(raw: &str) -> Vec<u32> {
    // `v22.14.0-rc.1` is 22.14.0: only the numbers before a prerelease or build tag count
    let trimmed = raw.trim().trim_start_matches('v').split(['-', '+']).next().unwrap_or("");
    let parts: Vec<u32> = trimmed.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.is_empty() {
        Vec::new()
    } else {
        parts
    }
}

/// Checks whether the Node that was found is actually a usable version.
///
/// **A too-low version and a missing one call for different actions from the person** — an
/// upgrade, not an install. So the messages are kept separate. If the version cannot be read,
/// it is let through (there is no basis for blocking it).
pub(super) fn check_node_version(path: &str) -> Result<String, String> {
    let mut cmd = Command::new(path);
    cmd.arg("--version").stdin(Stdio::null());
    hide_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return Ok(path.to_string());
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let floor = min_node()?;
    if below_floor(&raw, floor) {
        let floor = floor_text(floor);
        return Err(format!(
            "Node {floor} or newer is required, but {path} is {}: older than that, the bundled database \
             crashes on its first use.\n\
             {}, or switch to {floor} or newer with nvm or mise, then restart the app.",
            raw.trim(),
            upgrade_node_hint(Os::current())
        ));
    }
    Ok(path.to_string())
}
