//! Which OS this is is asked in the OS layer only (docs/plans/runtime-unification.md §3.3, step 1).
//!
//! The Rust side of `local/platform-checks` (#460, `tooling/platform-checks.test.ts`). In the
//! runtime's Rust (the keeper crate's `src/` and the window's `src/`), an OS predicate in
//! `cfg(…)`, `cfg!(…)` or the condition of `cfg_attr(…)` (`unix`, `windows`, `target_os`,
//! `target_family`, `target_vendor`, `target_env`) and reading `std::env::consts::OS` or `FAMILY`
//! fail this test outside:
//!
//!   - `MAY_ASK`: the OS layer (`keeper/src/os/`) and `start_plan`, whose `Os::current` is the one
//!     place that asks which OS this is for a decision;
//!   - `WINDOW_INTEGRATION`: the window's own OS integration, which is not runtime and stays where it
//!     is (§3.3: menus, traffic lights, trash, `code`);
//!   - `NOT_YET`: the sites that were there when this test was written, with their count. That list
//!     may only shrink: a file listed here may not gain a check, and a file that loses one must lower
//!     its count in the same change (the test fails on a stale count, so the list stays exact). Each
//!     step of the plan that moves a module into `os/` removes its rows; step 12 leaves it empty.
//!
//! Tests are not checked (they skip cases by OS), and neither is the shell crate, which is
//! macOS-only by definition. Comments and literals do not count.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Scanned, relative to `apps/desktop/src-tauri`.
const SCANNED: &[&str] = &["keeper/src", "src"];

/// Where it may be asked. A trailing `/` names a folder and everything under it.
const MAY_ASK: &[&str] = &["keeper/src/os/", "keeper/src/start_plan.rs"];

/// The window's OS integration, not the runtime: finding VS Code's `code`.
const WINDOW_INTEGRATION: &[&str] = &["src/ide.rs"];

/// Today's sites outside the OS layer, with how many each has. Only shrinks.
const NOT_YET: &[(&str, usize)] = &[
    // The keeper is unix-only until step 9 gives the OS layer a Windows half: the keeper's module,
    // its executable, and the keeper's half of the host supervisor (`host_proc/handover.rs`).
    ("keeper/src/host_proc/mod.rs", 6),
    ("keeper/src/lib.rs", 1),
    ("src/bin/centralu-keeper.rs", 2),
    // The window's start and quit (step 7). `src/lib.rs` also holds the window's own OS
    // integration (menus, traffic lights, badge, trash), which moves out of it to a module of its
    // own then, so that what is left here is runtime.
    ("src/lib.rs", 36),
    ("src/sidecar.rs", 28),
];

const OS_WORDS: &[&str] = &["unix", "windows", "target_os", "target_family", "target_vendor", "target_env"];

/// One OS check: its 1-based line and the check as written.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Site {
    line: usize,
    text: String,
}

/// What a file asks, and the out-of-line test modules it declares (`#[cfg(test)] mod tests;`).
#[derive(Debug, Default)]
struct Scan {
    sites: Vec<Site>,
    test_modules: Vec<String>,
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The source with comments and the contents of string and character literals blanked out. One
/// output char per input char, newlines kept, so positions and lines still match.
fn code_only(src: &str) -> Vec<char> {
    let s: Vec<char> = src.chars().collect();
    let mut out = s.clone();
    let blank = |out: &mut Vec<char>, from: usize, to: usize| {
        for k in from..to.min(out.len()) {
            if out[k] != '\n' {
                out[k] = ' ';
            }
        }
    };
    let at = |k: usize| s.get(k).copied();
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        let prev_ident = i > 0 && is_ident(s[i - 1]);
        if c == '/' && at(i + 1) == Some('/') {
            let mut j = i;
            while j < s.len() && s[j] != '\n' {
                j += 1;
            }
            blank(&mut out, i, j);
            i = j;
        } else if c == '/' && at(i + 1) == Some('*') {
            let (mut j, mut depth) = (i + 2, 1);
            while j < s.len() && depth > 0 {
                if s[j] == '/' && at(j + 1) == Some('*') {
                    depth += 1;
                    j += 2;
                } else if s[j] == '*' && at(j + 1) == Some('/') {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(&mut out, i, j);
            i = j;
        } else if !prev_ident && (c == 'r' || (c == 'b' && at(i + 1) == Some('r'))) && {
            let mut j = if c == 'b' { i + 2 } else { i + 1 };
            while at(j) == Some('#') {
                j += 1;
            }
            at(j) == Some('"')
        } {
            // A raw string: r"…", r#"…"#, br#"…"#.
            let mut j = if c == 'b' { i + 2 } else { i + 1 };
            let mut hashes = 0;
            while at(j) == Some('#') {
                hashes += 1;
                j += 1;
            }
            let open = j;
            j += 1;
            loop {
                if j >= s.len() {
                    break;
                }
                if s[j] == '"' && (1..=hashes).all(|h| at(j + h) == Some('#')) {
                    break;
                }
                j += 1;
            }
            blank(&mut out, open + 1, j);
            i = j + 1 + hashes;
        } else if c == '"' {
            let mut j = i + 1;
            while j < s.len() && s[j] != '"' {
                j += if s[j] == '\\' { 2 } else { 1 };
            }
            blank(&mut out, i + 1, j);
            i = j + 1;
        } else if c == '\'' {
            // A character literal ('x', '\n', '\'', '\u{1F600}') or a lifetime ('a).
            if at(i + 1) == Some('\\') {
                let mut j = i + 3;
                while j < s.len() && s[j] != '\'' {
                    j += 1;
                }
                blank(&mut out, i + 1, j);
                i = j + 1;
            } else if at(i + 2) == Some('\'') {
                blank(&mut out, i + 1, i + 2);
                i += 3;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    out
}

/// The index just past the bracket that closes the one at `open`.
fn closing(code: &[char], open: usize) -> Option<usize> {
    let (o, c) = match code[open] {
        '(' => ('(', ')'),
        '[' => ('[', ']'),
        '{' => ('{', '}'),
        _ => return None,
    };
    let mut depth = 0;
    for k in open..code.len() {
        if code[k] == o {
            depth += 1;
        } else if code[k] == c {
            depth -= 1;
            if depth == 0 {
                return Some(k + 1);
            }
        }
    }
    None
}

fn skip_ws(code: &[char], mut i: usize) -> usize {
    while i < code.len() && code[i].is_whitespace() {
        i += 1;
    }
    i
}

fn word_at(code: &[char], i: usize) -> String {
    code[i..].iter().take_while(|c| is_ident(**c)).collect()
}

fn starts_with(code: &[char], i: usize, what: &str) -> bool {
    let w: Vec<char> = what.chars().collect();
    code.len() >= i + w.len() && code[i..i + w.len()] == w[..]
}

/// Blanks `#[cfg(test)]` modules written inline and returns the names of those declared out of line.
fn drop_test_modules(code: &mut [char]) -> Vec<String> {
    let mut declared = Vec::new();
    let mut i = 0;
    while i < code.len() {
        if !starts_with(code, i, "#[cfg(test)]") {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        // This attribute and any after it.
        while j < code.len() && code[j] == '#' {
            let open = skip_ws(code, j + 1);
            match closing(code, open) {
                Some(end) => j = skip_ws(code, end),
                None => break,
            }
        }
        if word_at(code, j) == "pub" {
            j = skip_ws(code, j + 3);
            if j < code.len() && code[j] == '(' {
                j = skip_ws(code, closing(code, j).unwrap_or(j + 1));
            }
        }
        if word_at(code, j) != "mod" {
            i += 1;
            continue;
        }
        j = skip_ws(code, j + 3);
        let name = word_at(code, j);
        j = skip_ws(code, j + name.len());
        if j < code.len() && code[j] == ';' {
            declared.push(name);
            i = j + 1;
        } else if j < code.len() && code[j] == '{' {
            let end = closing(code, j).unwrap_or(code.len());
            for k in start..end {
                if code[k] != '\n' {
                    code[k] = ' ';
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    declared
}

fn line_of(code: &[char], i: usize) -> usize {
    1 + code[..i].iter().filter(|c| **c == '\n').count()
}

fn asks_os(predicate: &str) -> bool {
    predicate.split(|c: char| !is_ident(c)).any(|w| OS_WORDS.contains(&w))
}

fn scan(src: &str) -> Scan {
    let original: Vec<char> = src.chars().collect();
    let mut code = code_only(src);
    let test_modules = drop_test_modules(&mut code);
    let mut sites = Vec::new();
    let mut i = 0;
    while i < code.len() {
        if i > 0 && is_ident(code[i - 1]) {
            i += 1;
            continue;
        }
        let word = word_at(&code, i);
        let after = i + word.len();
        let check = match word.as_str() {
            "cfg" | "cfg_attr" => {
                let mut j = skip_ws(&code, after);
                if word == "cfg" && j < code.len() && code[j] == '!' {
                    j = skip_ws(&code, j + 1);
                }
                if j < code.len() && code[j] == '(' {
                    closing(&code, j).map(|end| {
                        let inner: String = code[j + 1..end - 1].iter().collect();
                        // For cfg_attr, only the condition: `cfg_attr(not(debug_assertions),
                        // windows_subsystem = "windows")` does not ask which OS this is.
                        let predicate = if word == "cfg_attr" {
                            let mut depth = 0;
                            let cut = inner
                                .char_indices()
                                .find(|(_, c)| {
                                    match c {
                                        '(' => depth += 1,
                                        ')' => depth -= 1,
                                        ',' if depth == 0 => return true,
                                        _ => {}
                                    }
                                    false
                                })
                                .map_or(inner.len(), |(k, _)| k);
                            inner[..cut].to_string()
                        } else {
                            inner
                        };
                        (end, asks_os(&predicate))
                    })
                } else {
                    None
                }
            }
            "consts" => {
                let j = skip_ws(&code, after);
                if starts_with(&code, j, "::") {
                    let k = skip_ws(&code, j + 2);
                    let name = word_at(&code, k);
                    Some((k + name.len(), name == "OS" || name == "FAMILY"))
                } else {
                    None
                }
            }
            _ => None,
        };
        match check {
            Some((end, true)) => {
                let text: String = original[i..end].iter().collect();
                sites.push(Site { line: line_of(&code, i), text: text.split_whitespace().collect::<Vec<_>>().join(" ") });
                i = end;
            }
            _ => i = after.max(i + 1),
        }
    }
    Scan { sites, test_modules }
}

fn src_tauri() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("keeper/ sits in src-tauri/").to_path_buf()
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")
}

/// Where a file's child modules live: beside a crate root or a `mod.rs`, in a folder named for it otherwise.
fn module_dir(file: &Path) -> PathBuf {
    let parent = file.parent().unwrap();
    let name = file.file_name().unwrap().to_string_lossy();
    let crate_root = name == "lib.rs" || name == "main.rs" || parent.ends_with("bin");
    if crate_root || name == "mod.rs" {
        parent.to_path_buf()
    } else {
        parent.join(file.file_stem().unwrap())
    }
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let p = entry.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|e| e == "rs") {
            out.push(p);
        }
    }
}

/// Every runtime file with at least one OS check, relative to src-tauri, with its sites.
fn sites_in_the_runtime() -> BTreeMap<String, Vec<Site>> {
    let root = src_tauri();
    let mut files = Vec::new();
    for d in SCANNED {
        rust_files(&root.join(d), &mut files);
    }
    let mut test_files = BTreeSet::new();
    let mut found = BTreeMap::new();
    for f in &files {
        let s = scan(&fs::read_to_string(f).unwrap());
        for m in &s.test_modules {
            let dir = module_dir(f);
            test_files.insert(dir.join(format!("{m}.rs")));
            test_files.insert(dir.join(m).join("mod.rs"));
        }
        if !s.sites.is_empty() {
            found.insert(f.clone(), s.sites);
        }
    }
    found.into_iter().filter(|(f, _)| !test_files.contains(f)).map(|(f, s)| (rel(&root, &f), s)).collect()
}

fn may_ask(file: &str) -> bool {
    MAY_ASK.iter().chain(WINDOW_INTEGRATION).any(|m| if m.ends_with('/') { file.starts_with(m) } else { file == *m })
}

#[test]
fn the_runtime_asks_which_os_only_in_the_os_layer() {
    let found = sites_in_the_runtime();
    let mut problems = Vec::new();
    for (file, sites) in &found {
        if may_ask(file) {
            continue;
        }
        let list = sites.iter().map(|s| format!("    {file}:{}  {}", s.line, s.text)).collect::<Vec<_>>().join("\n");
        match NOT_YET.iter().find(|(f, _)| f == file) {
            None => problems.push(format!(
                "{file} asks which OS this is ({} site(s)). Put the mechanism in keeper/src/os/ and ask it a question named for what differs:\n{list}",
                sites.len()
            )),
            Some((_, n)) if sites.len() > *n => problems.push(format!(
                "{file} has {} OS checks, the allow-list {n}; it may only shrink. Put the new one in keeper/src/os/:\n{list}",
                sites.len()
            )),
            Some((_, n)) if sites.len() < *n => problems.push(format!(
                "{file} is down to {} OS checks: lower its count in NOT_YET from {n} to {}",
                sites.len(),
                sites.len()
            )),
            _ => {}
        }
    }
    for (file, _) in NOT_YET {
        if !found.contains_key(*file) {
            problems.push(format!("{file} asks nothing any more: remove it from NOT_YET"));
        }
    }
    assert!(problems.is_empty(), "\n{}\n", problems.join("\n\n"));
}

#[test]
fn the_lists_name_only_what_exists() {
    let root = src_tauri();
    for m in MAY_ASK.iter().chain(WINDOW_INTEGRATION) {
        assert!(root.join(m.trim_end_matches('/')).exists() || *m == "keeper/src/os/", "{m} does not exist");
    }
    for (f, _) in NOT_YET {
        assert!(root.join(f).exists(), "{f} does not exist: remove it from NOT_YET");
        assert!(!may_ask(f), "{f} is both allowed and on NOT_YET");
    }
}

fn texts(src: &str) -> Vec<String> {
    scan(src).sites.into_iter().map(|s| s.text).collect()
}

#[test]
fn finds_every_way_of_asking() {
    let src = "#[cfg(unix)]\nfn a() {}\n#[cfg(not(windows))]\nfn b() { if cfg!(target_os = \"macos\") {} }\n\
               #[cfg_attr(not(target_os = \"linux\"), allow(dead_code))]\nfn c() { let _ = std::env::consts::OS; }\n\
               #[cfg(any(\n    target_family = \"unix\",\n    target_env = \"gnu\"\n))]\nfn d() {}\n";
    let s = scan(src).sites;
    assert_eq!(s.iter().map(|s| s.line).collect::<Vec<_>>(), vec![1, 3, 4, 5, 6, 7]);
    assert_eq!(s[0].text, "cfg(unix)");
    assert_eq!(s[2].text, "cfg!(target_os = \"macos\")");
    assert_eq!(s[4].text, "consts::OS");
    assert!(s[5].text.starts_with("cfg(any( target_family"));
}

#[test]
fn other_conditions_are_not_asking() {
    let src = "#![cfg_attr(not(debug_assertions), windows_subsystem = \"windows\")]\n#[cfg(test)]\nfn t() {}\n\
               #[cfg(feature = \"test-key\")]\nfn k() { if cfg!(debug_assertions) {} }\nfn unix_like() { my_cfg(windows); }\n\
               #[cfg_attr(mobile, tauri::mobile_entry_point)]\nfn m() { let _ = consts::ARCH; }\n";
    assert_eq!(texts(src), Vec::<String>::new());
}

#[test]
fn comments_and_literals_do_not_count() {
    let src = "// #[cfg(unix)]\n/* cfg(windows) /* nested cfg(unix) */ still */\n/// see `cfg!(unix)`\n\
               fn a<'a>(x: &'a str) -> char { let _ = \"#[cfg(unix)]\\\" cfg(unix)\"; let _ = r#\"cfg(windows)\"#;\n\
               let _ = '\"'; let _ = b'\\''; let _ = br\"cfg(unix)\"; '{' }\n#[cfg(windows)]\nfn b() {}\n";
    let s = scan(src).sites;
    assert_eq!(s.len(), 1, "{s:?}");
    assert_eq!(s[0].line, 6);
}

#[test]
fn test_modules_are_not_checked() {
    let src = "#[cfg(unix)]\nfn a() {}\n#[cfg(test)]\n#[allow(dead_code)]\nmod tests {\n    #[cfg(unix)]\n    fn x() { let _ = '}'; }\n    mod inner { #[cfg(windows)] fn y() {} }\n}\n\
               #[cfg(test)]\npub(crate) mod more_tests;\n#[cfg(windows)]\nfn b() {}\n";
    let s = scan(src);
    assert_eq!(s.sites.iter().map(|s| s.line).collect::<Vec<_>>(), vec![1, 12]);
    assert_eq!(s.test_modules, vec!["more_tests".to_string()]);
}

#[test]
fn child_modules_resolve_like_rustc() {
    assert_eq!(module_dir(Path::new("k/src/lib.rs")), Path::new("k/src"));
    assert_eq!(module_dir(Path::new("k/src/a/mod.rs")), Path::new("k/src/a"));
    assert_eq!(module_dir(Path::new("k/src/a/content.rs")), Path::new("k/src/a/content"));
    assert_eq!(module_dir(Path::new("k/src/bin/tool.rs")), Path::new("k/src/bin"));
}
