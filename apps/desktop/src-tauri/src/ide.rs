//! VS Code의 `code` 명령 찾기 (#159).
//!
//! GUI로 띄운 `.app`은 로그인 셸의 PATH를 물려받지 못해 `/usr/bin:/bin:/usr/sbin:/sbin`만
//! 받는다 (sidecar.rs의 `resolve_node`가 같은 실측을 적어 두었다). `code`는 그 네 곳 어디에도
//! 없어서, 이름만 주고 실행하던 예전의 "Open in IDE"는 VS Code가 깔린 맥에서도 설치본에서는
//! 언제나 `No such file or directory`로 끝났다. `tauri dev`는 터미널의 PATH를 물려받으므로
//! 개발 중에는 보이지 않았다. npm 런처도 `open -a`로 띄우니 같은 PATH를 받는다.
//!
//! 로그인 셸에게 묻지 않고 자리를 차례로 본다. 셸을 띄우면 누를 때마다 1초 안팎이 들고,
//! `code`가 사는 자리는 몇 곳으로 정해져 있다.

use std::path::{Path, PathBuf};

/// 찾아볼 자리들, 순서대로.
///
/// 지금 PATH가 먼저다 — 개발 중이거나 터미널에서 띄운 앱이면 사람이 쓰는 바로 그 `code`다.
/// 그다음 VS Code의 "Install 'code' command in PATH"가 링크를 두는 자리와 홈브류, 마지막으로
/// 앱 번들 안의 원본(링크를 한 번도 깔지 않은 사람도 VS Code는 있다).
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

/// 처음 있는 것을 고른다. `exists`를 받는 것은 파일시스템 없이 시험하기 위해서다.
///
/// 못 찾으면 **어디를 봤는지** 말한다 — "없다"만으로는 사람이 무엇을 고칠지 모른다.
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

/// 이 프로세스의 PATH와 홈으로 `code`를 찾는다.
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

    /// GUI로 띄운 앱이 실제로 받는 PATH (sidecar.rs의 실측)
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
        // 이 맥의 모양: /usr/local/bin/code는 없고 홈브류에 있다
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
