//! agent-host 사이드카 수퍼바이저.
//!
//! Tauri의 역할은 통신 릴레이가 아니라 **프로세스 감독**이다 (docs/architecture.md §4).
//! host를 띄우고, ready 줄에서 포트·토큰을 읽어 UI에 넘기고, 죽으면 되살린다.
//! 통신 자체는 UI가 WS로 직접 한다 — dev와 prod가 같은 경로를 쓰는 이유.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HostStatus {
    Starting,
    Ready(HostInfo),
    /// 재시작 시도 중 (몇 번째인지)
    Restarting { attempt: u32 },
    /// 되살리기를 포기했다 — UI가 사용자에게 알려야 한다
    Failed { message: String },
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    info: Option<HostInfo>,
    status_text: Option<String>,
    shutting_down: bool,
}

#[derive(Clone, Default)]
pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
}

/// 재시작 백오프 상한. 이 이상 실패하면 사람이 봐야 하는 문제다.
const MAX_RESTARTS: u32 = 5;

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn info(&self) -> Option<HostInfo> {
        self.inner.lock().ok()?.info.clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.inner.lock().ok()?.status_text.clone()
    }

    /// host를 띄우고 감시 스레드를 건다. 실패해도 앱은 계속 뜬다 (UI가 상태를 보여준다).
    pub fn start(&self, app: AppHandle) {
        let me = self.clone();
        // 배포 빌드에서는 번들된 host가 리소스 디렉토리에 들어 있다 (F-0).
        let bundled = app
            .path()
            .resource_dir()
            .ok()
            .map(|d| d.join("resources/host/main.mjs"))
            .filter(|p| p.exists());
        thread::spawn(move || {
            // Node가 없으면 몇 번을 다시 걸어도 결과가 같다 — 백오프 5회를 돌며
            // 원인 없는 실패를 쌓는 대신 지금 바로, 무엇이 없는지 말한다.
            if bundled.is_some() && std::env::var("CC_HOST_CMD").is_err() {
                if let Err(message) = resolve_node() {
                    me.set_error(&message);
                    emit(&app, HostStatus::Failed { message });
                    return;
                }
            }
            let mut attempt = 0u32;
            loop {
                if me.inner.lock().map(|i| i.shutting_down).unwrap_or(true) {
                    return;
                }
                emit(&app, if attempt == 0 { HostStatus::Starting } else { HostStatus::Restarting { attempt } });

                match me.spawn_once(&app, bundled.as_deref()) {
                    Ok(code) => {
                        // 정상 종료(앱 종료 요청)면 감시를 끝낸다
                        if me.inner.lock().map(|i| i.shutting_down).unwrap_or(true) {
                            return;
                        }
                        attempt += 1;
                        let msg = format!("agent-host가 종료되었습니다 (code {code:?})");
                        if attempt > MAX_RESTARTS {
                            me.set_error(&msg);
                            emit(&app, HostStatus::Failed { message: msg });
                            return;
                        }
                    }
                    Err(e) => {
                        attempt += 1;
                        let msg = format!("agent-host를 시작하지 못했습니다: {e}");
                        if attempt > MAX_RESTARTS {
                            me.set_error(&msg);
                            emit(&app, HostStatus::Failed { message: msg });
                            return;
                        }
                    }
                }
                // 지수 백오프 (최대 5초)
                thread::sleep(Duration::from_millis((200 * 2u64.pow(attempt.min(5))).min(5000)));
            }
        });
    }

    /// host 한 번 실행 → ready 줄 파싱 → 종료까지 대기. 반환값은 종료 코드.
    fn spawn_once(&self, app: &AppHandle, bundled: Option<&Path>) -> Result<Option<i32>, String> {
        let (program, args) = host_command(bundled)?;
        let mut cmd = Command::new(&program);
        // stdin을 파이프로 열어두는 것이 **고아 방지의 핵심**이다.
        // 앱이 어떤 이유로 죽든(크래시·SIGKILL 포함) 이 파이프가 닫히고,
        // host는 EOF를 보고 스스로 종료한다. 종료 훅에만 기대면 강제 종료 때 좀비가 남는다.
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // dev로 띄운 host는 배포 앱과 **다른 데이터 폴더**를 쓴다.
        // 같은 폴더를 두 host가 붙잡으면 세션 목록이 어긋난다.
        if bundled.is_none() {
            cmd.env("CC_DEV", "1");
        }

        // 자식을 **자기 자신이 리더인 프로세스 그룹**에 넣는다.
        // node 실행기(tsx)는 다시 자식을 낳으므로, 그룹째 죽이지 않으면 손자가 고아로 남는다.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| format!("{program} 실행 실패: {e}"))?;

        let stdout = child.stdout.take().ok_or("stdout을 열 수 없습니다")?;

        if let Ok(mut inner) = self.inner.lock() {
            inner.child = Some(child);
        }

        // ready 줄을 기다린다. host는 기동 시 {"ready":true,"port":..,"token":".."}를 한 줄 출력한다.
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("ready").and_then(|r| r.as_bool()) == Some(true) {
                    let info = HostInfo {
                        port: v.get("port").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                        token: v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                    };
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.info = Some(info.clone());
                        inner.status_text = None;
                    }
                    emit(app, HostStatus::Ready(info));
                    continue;
                }
            }
            // 그 외 줄은 로그로 흘린다
            eprintln!("[agent-host] {line}");
        }

        // stdout이 닫혔다 = 프로세스가 끝났다
        let mut guard = self.inner.lock().map_err(|_| "lock 실패")?;
        guard.info = None;
        let code = guard
            .child
            .as_mut()
            .and_then(|c| c.wait().ok())
            .and_then(|s| s.code());
        guard.child = None;
        Ok(code)
    }

    fn set_error(&self, msg: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status_text = Some(msg.to_string());
        }
    }

    /// 앱 종료 시 호출. 사이드카를 **그룹째** 죽인다 — 좀비를 남기지 않는다.
    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.shutting_down = true;
            if let Some(child) = inner.child.as_mut() {
                kill_group(child.id());
                // 정리할 시간을 조금 준 뒤 확인 사살
                thread::sleep(Duration::from_millis(300));
                let _ = child.kill();
                let _ = child.wait();
            }
            inner.child = None;
            inner.info = None;
        }
    }
}

fn emit(app: &AppHandle, status: HostStatus) {
    let _ = app.emit("host-status", status);
}

/// 프로세스 그룹 전체에 SIGTERM (음수 pid = 그룹)
#[cfg(unix)]
fn kill_group(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

/// dev에서는 워크스페이스의 tsx로, 배포 빌드에서는 번들된 host를 시스템 Node로 실행한다 (F-0).
///
/// **패키지 매니저를 거치지 않는다** — pnpm 래퍼를 통해 띄우면 래퍼만 죽고
/// 실제 host(손자)가 고아로 남는다 (실측으로 확인된 문제).
fn host_command(bundled: Option<&Path>) -> Result<(String, Vec<String>), String> {
    if let Ok(cmd) = std::env::var("CC_HOST_CMD") {
        let mut parts = cmd.split_whitespace().map(String::from).collect::<Vec<_>>();
        if !parts.is_empty() {
            let program = parts.remove(0);
            return Ok((program, parts));
        }
    }

    // 배포 빌드: 번들된 host를 시스템 Node로 실행한다 (F-0a 결정).
    // Node SEA는 네이티브 애드온 때문에 비용이 과해 도그푸딩 범위에서 제외했다.
    if let Some(path) = bundled {
        return Ok((
            resolve_node()?,
            vec![
                path.to_string_lossy().to_string(),
                "--port".into(),
                "0".into(),
                "--watch-parent".into(),
            ],
        ));
    }

    // dev: 워크스페이스의 tsx로 소스를 직접 실행.
    // CC_DEV로 표시해 두면 host가 배포 앱과 **다른 데이터 폴더**를 쓴다 —
    // 둘을 동시에 켜도 세션 목록이 섞이지 않는다.
    let root = workspace_root();
    Ok((
        format!("{root}/node_modules/.bin/tsx"),
        vec![
            format!("{root}/packages/agent-host/src/main.ts"),
            "--port".into(),
            "0".into(),
            "--watch-parent".into(),
        ],
    ))
}

/// Node를 찾지 못했을 때 사용자에게 그대로 보여줄 안내.
///
/// **조용한 실패가 최악이다.** 예전에는 못 찾으면 `"node"`를 그냥 실행해
/// `No such file or directory`만 남았고, 화면에는 그 원문이 떴다.
/// Node가 없는 것인지, 있는데 못 찾는 것인지, 버전이 낮은 것인지 갈리지 않았다.
fn node_missing_message(looked: &[String]) -> String {
    format!(
        "Node.js를 찾지 못했습니다. Control Center는 Node {MIN_NODE_MAJOR} 이상이 필요합니다.\n\
         터미널에서 `node --version`으로 확인하고, 없으면 `brew install node` 또는 \
         https://nodejs.org 에서 설치한 뒤 앱을 다시 시작하세요.\n\
         찾아본 곳: {}",
        looked.join(", ")
    )
}

/// host 번들의 esbuild target이 node22다 — 그 아래에서는 문법부터 깨진다.
const MIN_NODE_MAJOR: u32 = 22;

/// Node 탐색은 로그인 셸을 통째로 띄우므로 1초 안팎이 든다. 프로세스가 사는 동안
/// PATH가 달라질 일은 없으니 한 번만 묻는다 (재시작 루프가 매번 부른다).
static NODE: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();

/// 배포 빌드가 host를 실행할 Node의 **절대 경로**를 찾는다.
///
/// **왜 고정 경로로는 안 되는가 (실측):** GUI로 띄운 `.app`은 로그인 셸의 PATH를
/// 물려받지 못해 `/usr/bin:/bin:/usr/sbin:/sbin`만 들어온다. 예전에는 homebrew
/// 두 곳과 `/usr/bin`만 봤는데, nvm·mise·volta로 깐 Node는 홈 디렉토리 아래 있어
/// **Node가 멀쩡히 설치된 맥에서도 앱이 뜨지 않았다.**
/// claude·codex CLI 탐색에서 이미 같은 문제를 겪고 로그인 셸에게 묻도록 고쳤는데
/// (`packages/agent-host/src/env-path.ts`), node만 옛 방식으로 남아 있었다.
fn resolve_node() -> Result<String, String> {
    NODE.get_or_init(|| pick_node(probe_login_shell(), fallback_node_paths()))
        .clone()
}

/// 어느 것을 고를지의 규칙만 따로 뗀 것 — 셸도 파일시스템도 없이 시험할 수 있게.
///
/// 순서: 로그인 셸이 아는 것(사용자가 터미널에서 쓰는 그 node) → 흔한 설치 위치.
/// **낡았다고 거기서 멈추지 않는다** — nvm 기본이 v18이고 홈브류에 v22가 있는 맥이 흔하다.
/// 다만 낡은 것을 만났다는 사실은 들고 가서, 끝내 못 찾으면 그 이유를 대신 보여준다
/// ("없음"보다 "올려야 함"이 사용자가 할 일에 가깝다).
fn pick_node(from_shell: Option<String>, fallbacks: Vec<String>) -> Result<String, String> {
    let mut looked = vec!["로그인 셸 PATH".to_string()];
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

/// 로그인 셸에게 node의 위치를 묻는다. 대화형(-i)이어야 .zshrc의 nvm/mise 초기화가 돈다.
///
/// 셸 설정이 무엇을 출력하든 상관없도록 표식이 붙은 줄만 고른다.
fn probe_login_shell() -> Option<String> {
    use std::io::Read;

    let shell = std::env::var("SHELL").ok()?;
    if !Path::new(&shell).exists() {
        return None;
    }

    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", "command -p echo \"__CC_NODE__:$(command -v node)\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // 셸 초기화 스크립트가 대화형 프롬프트를 띄우지 않도록
        .env("TERM", "dumb")
        .env("CI", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let stdout = child.stdout.take()?;

    // **여기서 멈추면 앱이 통째로 기동 실패한다.** 셸 설정이 무한히 기다리는 일이
    // 실제로 있으므로(예: 프롬프트 입력 대기) 시간을 끊고 그룹째 죽인다.
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stdout).read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let out = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(out) => out,
        Err(_) => {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();

    parse_probe_output(&out)
}

/// 셸이 뱉은 것 중 표식이 붙은 줄에서 경로만 꺼낸다.
fn parse_probe_output(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix("__CC_NODE__:"))
        .map(str::trim)
        .filter(|p| !p.is_empty() && Path::new(p).exists())
        .map(str::to_string)
}

/// 셸을 못 쓸 때의 폴백. 홈브류뿐 아니라 버전 매니저의 흔한 자리까지 본다.
fn fallback_node_paths() -> Vec<String> {
    node_paths_under(&std::env::var("HOME").unwrap_or_default())
}

fn node_paths_under(home: &str) -> Vec<String> {
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
        // nvm은 버전마다 디렉토리가 갈린다 — 가장 높은 버전을 고른다
        paths.extend(nvm_versions(&format!("{home}/.nvm/versions/node")));
    }
    paths
}

/// `~/.nvm/versions/node/*/bin/node`를 버전 내림차순으로.
///
/// 이름이 `v22.3.1` 꼴이라 사전순은 v9 > v22가 되어 틀린다. 숫자로 비교한다.
fn nvm_versions(root: &str) -> Vec<String> {
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

/// `v22.3.1` → `[22, 3, 1]`. 숫자로 안 읽히면 빈 벡터.
fn version_parts(raw: &str) -> Vec<u32> {
    let trimmed = raw.trim().trim_start_matches('v');
    let parts: Vec<u32> = trimmed.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.is_empty() {
        Vec::new()
    } else {
        parts
    }
}

/// 찾은 Node가 실제로 쓸 수 있는 버전인지 본다.
///
/// **버전이 낮은 것과 없는 것은 사용자가 할 일이 다르다** — 설치가 아니라 업그레이드다.
/// 그래서 메시지를 갈라 놓는다. 버전을 못 읽으면 통과시킨다(막을 근거가 없다).
fn check_node_version(path: &str) -> Result<String, String> {
    let Ok(out) = Command::new(path).arg("--version").stdin(Stdio::null()).output() else {
        return Ok(path.to_string());
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let Some(&major) = version_parts(raw.trim()).first() else {
        return Ok(path.to_string());
    };
    if major < MIN_NODE_MAJOR {
        return Err(format!(
            "Node {MIN_NODE_MAJOR} 이상이 필요한데 {path}는 {}입니다.\n\
             `brew upgrade node` 또는 nvm·mise로 {MIN_NODE_MAJOR} 이상을 켠 뒤 앱을 다시 시작하세요.",
            raw.trim()
        ));
    }
    Ok(path.to_string())
}

fn workspace_root() -> String {
    // src-tauri/ 기준 두 단계 위가 apps/, 세 단계 위가 워크스페이스 루트
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_marked_line_only() {
        // 셸 설정이 무엇을 출력하든(배너·경고) 표식이 붙은 줄만 본다
        let out = "Welcome to zsh!\n__CC_NODE__:/bin/sh\nsome trailing noise\n";
        assert_eq!(parse_probe_output(out), Some("/bin/sh".to_string()));
    }

    #[test]
    fn ignores_a_path_that_is_not_there() {
        // command -v가 빈 문자열을 주거나(설치 안 됨) 죽은 심링크를 줄 수 있다
        assert_eq!(parse_probe_output("__CC_NODE__:\n"), None);
        assert_eq!(parse_probe_output("__CC_NODE__:/nope/node\n"), None);
        assert_eq!(parse_probe_output("node not found\n"), None);
    }

    #[test]
    fn compares_versions_as_numbers_not_text() {
        // 사전순이면 v9 > v22가 되어 낡은 Node를 고른다
        assert!(version_parts("v22.3.1") > version_parts("v9.11.2"));
        assert_eq!(version_parts("v22.3.1"), vec![22, 3, 1]);
        assert_eq!(version_parts("lts/*"), Vec::<u32>::new());
        assert_eq!(version_parts(""), Vec::<u32>::new());
    }

    /// node인 척하며 주어진 버전을 찍는 스크립트를 하나 세운다
    fn fake_node(version: &str, name: &str) -> String {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho {version}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_string_lossy().to_string()
    }

    #[test]
    fn rejects_a_node_that_is_too_old() {
        // 낮은 버전은 "없음"이 아니라 "올려야 함"이다 — 사용자가 할 일이 다르다
        let path = fake_node("v20.11.1", "cc-test-node-old");
        let err = check_node_version(&path).unwrap_err();
        assert!(err.contains("이상이 필요한데"), "{err}");
        assert!(err.contains("v20.11.1"), "{err}");
    }

    #[test]
    fn accepts_a_node_that_is_new_enough() {
        let path = fake_node("v22.3.1", "cc-test-node-ok");
        assert_eq!(check_node_version(&path), Ok(path));
    }

    #[test]
    fn passes_when_the_version_cannot_be_read() {
        // 막을 근거가 없으면 막지 않는다 (예상 못 한 출력 형식)
        let path = fake_node("banana", "cc-test-node-weird");
        assert_eq!(check_node_version(&path), Ok(path));
    }

    /// 이 맥의 로그인 셸이 아는 node를 실제로 집어내는지 본다.
    ///
    /// 단위 테스트로는 "고정 경로가 아니라 셸에게 묻는다"를 확인할 수 없다 —
    /// 그게 이 수정의 전부이므로 실물로 한 번 건드린다.
    /// node가 없는 환경에서는 조용히 통과한다(막을 근거가 없다).
    #[test]
    fn finds_the_node_this_shell_knows() {
        let Ok(shell) = std::env::var("SHELL") else { return };
        if !Path::new(&shell).exists() {
            return;
        }
        let Ok(out) = Command::new(&shell).args(["-ilc", "command -v node"]).output() else {
            return;
        };
        let expected = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if expected.is_empty() || !Path::new(&expected).exists() {
            return;
        }
        assert_eq!(probe_login_shell(), Some(expected.clone()));
        assert_eq!(resolve_node(), Ok(expected));
    }

    #[test]
    fn moves_on_when_the_shell_node_is_too_old() {
        // nvm 기본이 v18인데 홈브류에 v22가 있는 맥 — 여기서 멈추면 쓸 수 있는데도 못 뜬다
        let old = fake_node("v18.20.4", "cc-test-node-shell-old");
        let new = fake_node("v22.9.0", "cc-test-node-brew-new");
        assert_eq!(pick_node(Some(old), vec![new.clone()]), Ok(new));
    }

    #[test]
    fn explains_the_old_version_when_there_is_nothing_newer() {
        // 끝내 못 찾았으면 "없음"이 아니라 "낡음"을 말한다 — 할 일이 설치가 아니라 업그레이드다
        let old = fake_node("v18.20.4", "cc-test-node-only-old");
        let err = pick_node(Some(old), vec!["/nope/node".into()]).unwrap_err();
        assert!(err.contains("v18.20.4"), "{err}");
        assert!(!err.contains("찾지 못했습니다"), "{err}");
    }

    #[test]
    fn reports_every_place_it_looked_when_nothing_is_there() {
        // 아무 데도 없을 때가 사용자가 가장 막막한 순간이다 — 찾아본 곳을 다 적는다
        let err = pick_node(None, vec!["/nope/a/node".into(), "/nope/b/node".into()]).unwrap_err();
        assert!(err.contains("로그인 셸 PATH"), "{err}");
        assert!(err.contains("/nope/a/node") && err.contains("/nope/b/node"), "{err}");
    }

    #[test]
    fn falls_back_to_a_real_path_when_the_shell_says_nothing() {
        let ok = fake_node("v22.0.0", "cc-test-node-fallback");
        assert_eq!(pick_node(None, vec!["/nope/node".into(), ok.clone()]), Ok(ok));
    }

    #[test]
    fn looks_where_version_managers_actually_put_node() {
        // 예전에는 homebrew 두 곳과 /usr/bin뿐이었다 — nvm·mise·volta 사용자가 여기서 막혔다
        let paths = node_paths_under("/home/tester");
        for expected in [
            "/opt/homebrew/bin/node",
            "/home/tester/.volta/bin/node",
            "/home/tester/.local/share/mise/shims/node",
            "/home/tester/.asdf/shims/node",
        ] {
            assert!(paths.iter().any(|p| p == expected), "{expected} 가 후보에 없다: {paths:?}");
        }
    }

    #[test]
    fn says_where_it_looked_when_there_is_no_node() {
        let msg = node_missing_message(&["로그인 셸 PATH".into(), "/opt/homebrew/bin/node".into()]);
        assert!(msg.contains("로그인 셸 PATH"));
        assert!(msg.contains("/opt/homebrew/bin/node"));
        assert!(msg.contains("22"));
    }
}
