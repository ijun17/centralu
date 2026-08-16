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
        let (program, args) = host_command(bundled);
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
fn host_command(bundled: Option<&Path>) -> (String, Vec<String>) {
    if let Ok(cmd) = std::env::var("CC_HOST_CMD") {
        let mut parts = cmd.split_whitespace().map(String::from).collect::<Vec<_>>();
        if !parts.is_empty() {
            let program = parts.remove(0);
            return (program, parts);
        }
    }

    // 배포 빌드: 번들된 host를 시스템 Node로 실행한다 (F-0a 결정).
    // Node SEA는 네이티브 애드온 때문에 비용이 과해 도그푸딩 범위에서 제외했다.
    if let Some(path) = bundled {
        return (
            node_program(),
            vec![
                path.to_string_lossy().to_string(),
                "--port".into(),
                "0".into(),
                "--watch-parent".into(),
            ],
        );
    }

    // dev: 워크스페이스의 tsx로 소스를 직접 실행.
    // CC_DEV로 표시해 두면 host가 배포 앱과 **다른 데이터 폴더**를 쓴다 —
    // 둘을 동시에 켜도 세션 목록이 섞이지 않는다.
    let root = workspace_root();
    (
        format!("{root}/node_modules/.bin/tsx"),
        vec![
            format!("{root}/packages/agent-host/src/main.ts"),
            "--port".into(),
            "0".into(),
            "--watch-parent".into(),
        ],
    )
}

/// GUI 앱은 로그인 셸의 PATH를 물려받지 못한다 — node를 흔한 위치에서 직접 찾는다.
fn node_program() -> String {
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

fn workspace_root() -> String {
    // src-tauri/ 기준 두 단계 위가 apps/, 세 단계 위가 워크스페이스 루트
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}
