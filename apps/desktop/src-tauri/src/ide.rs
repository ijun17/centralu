//! Find VS Code's `code` command (#159).
//!
//! A `.app` launched from the GUI does not inherit the login shell's PATH, and gets only
//! `/usr/bin:/bin:/usr/sbin:/sbin` (sidecar.rs's `resolve_node` records the same measurement).
//! `code` lives in none of those four directories, so the old "Open in IDE", which just ran
//! the command by name, always ended in `No such file or directory` on the installed app, even
//! on a Mac with VS Code installed. `tauri dev` inherits the terminal's PATH, so this never
//! showed up during development. The npm launcher also launches with `open -a`, so it gets
//! the same PATH.
//!
//! This checks the known locations in order instead of asking the login shell. Spawning a
//! shell costs around one second every time the button is pressed, and the places `code` can
//! live are a short, fixed list.

use std::path::{Path, PathBuf};

/// The places to look, in order.
///
/// The current PATH comes first — during development, or when the app was launched from a
/// terminal, that is the exact `code` the person already uses. Next come the locations where
/// VS Code's "Install 'code' command in PATH" places the link, and Homebrew, and finally the
/// original inside the app bundle (someone can have VS Code installed without ever having
/// installed the link).
pub fn code_candidates(path_var: Option<&str>, home: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = path_var
        .map(|p| {
            std::env::split_paths(p)
                .map(|dir| dir.join("code"))
                .collect()
        })
        .unwrap_or_default();

    #[cfg(target_os = "macos")]
    {
        const BUNDLED: &str = "Visual Studio Code.app/Contents/Resources/app/bin/code";
        out.push(PathBuf::from("/usr/local/bin/code"));
        out.push(PathBuf::from("/opt/homebrew/bin/code"));
        out.push(Path::new("/Applications").join(BUNDLED));
        if !home.is_empty() {
            out.push(Path::new(home).join("Applications").join(BUNDLED));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = home;
        out.push(PathBuf::from("/usr/bin/code"));
        out.push(PathBuf::from("/usr/local/bin/code"));
        out.push(PathBuf::from("/snap/bin/code"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = home;

    out
}

/// Pick the first one that exists. `exists` is passed in so this can be tested without a real
/// filesystem.
///
/// If nothing is found, say **where it looked** — "not found" alone does not tell the person
/// what to fix.
pub fn pick_code(
    candidates: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    if let Some(found) = candidates.iter().find(|p| exists(p)) {
        return Ok(found.clone());
    }
    let looked: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    Err(format!(
        "VS Code's `code` command was not found (looked in: {}). \
         In VS Code, run \"Shell Command: Install 'code' command in PATH\".",
        looked.join(", ")
    ))
}

/// Find `code` using this process's PATH and home directory.
pub fn find_code() -> Result<PathBuf, String> {
    let path_var = std::env::var("PATH").ok();
    let home = std::env::var("HOME").unwrap_or_default();
    pick_code(&code_candidates(path_var.as_deref(), &home), |p| {
        p.is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The PATH a GUI-launched app actually gets (measured in sidecar.rs).
    const GUI_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

    #[test]
    fn path_comes_first_when_it_has_code() {
        let found = pick_code(
            &code_candidates(Some("/somewhere/bin:/usr/bin"), "/Users/me"),
            |p| p == Path::new("/somewhere/bin/code") || p == Path::new("/opt/homebrew/bin/code"),
        );
        assert_eq!(found, Ok(PathBuf::from("/somewhere/bin/code")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn gui_path_still_finds_homebrew_code() {
        // The shape of this particular Mac: no /usr/local/bin/code, but Homebrew has it.
        let found = pick_code(&code_candidates(Some(GUI_PATH), "/Users/me"), |p| {
            p == Path::new("/opt/homebrew/bin/code")
        });
        assert_eq!(found, Ok(PathBuf::from("/opt/homebrew/bin/code")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn gui_path_finds_the_bundled_code_without_any_link() {
        let bundled =
            "/Users/me/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
        let found = pick_code(&code_candidates(Some(GUI_PATH), "/Users/me"), |p| {
            p == Path::new(bundled)
        });
        assert_eq!(found, Ok(PathBuf::from(bundled)));
    }

    #[test]
    fn not_found_says_where_it_looked() {
        let err = pick_code(&code_candidates(Some(GUI_PATH), "/Users/me"), |_| false).unwrap_err();
        assert!(err.contains("/usr/bin/code"), "{err}");
        #[cfg(target_os = "macos")]
        assert!(err.contains("/opt/homebrew/bin/code"), "{err}");
        assert!(err.contains("Install 'code' command in PATH"), "{err}");
    }
}
