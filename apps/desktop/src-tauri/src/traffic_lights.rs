//! macOS 신호등 버튼을 우리 상단 바의 세로 가운데에 놓는다.
//!
//! `tauri.conf.json`의 `trafficLightPosition`만으로는 부족하다. macOS 26(Sequoia)부터
//! 창 관리자가 **리사이즈 이벤트와 동기적으로 버튼 위치를 확정하지 않아서**, 창이 뜨거나
//! 크기가 바뀔 때마다 버튼이 기본 자리로 되돌아간다. 실측에서도 설정은 바이너리에
//! 들어가 있는데 화면에서는 위에 붙은 채였다.
//!
//! 그래서 창 이벤트마다 다시 잡는다. 설정도 그대로 둔다 — 첫 프레임이 그려지기 전
//! 위치는 그쪽이 정하고, 여기서는 그 뒤를 책임진다.
//!
//! **버튼 간격은 우리가 정하지 않는다.** 첫 버튼이 있어야 할 자리와 지금 자리의 차이만큼
//! 세 개를 함께 옮긴다. macOS가 정한 간격을 그대로 두는 편이, 우리가 20pt 같은 숫자를
//! 적어 두고 OS가 바뀌면 어긋나는 것보다 낫다.

use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
use tauri::{Manager, WindowEvent};

/// 상단 바 높이(px). packages/ui의 App.tsx `h-9`와 같은 값이어야 한다.
const HEADER_H: f64 = 36.0;
/// 창 왼쪽에서 첫 버튼까지
const INSET_X: f64 = 19.0;

/// 창이 뜬 뒤와 모양이 바뀔 때마다 신호등을 제자리에 놓는다.
pub fn install(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };

    apply(&window);

    let w = window.clone();
    window.on_window_event(move |event| {
        // Moved까지 보는 이유: 화면 사이를 옮기면 배율이 달라져 좌표가 다시 잡힌다
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::Focused(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            apply(&w);
            apply_again_soon(&w);
        }
    });
}

/// 이벤트 직후에 몇 번 더 잡는다.
///
/// macOS 26은 리사이즈 **이벤트를 먼저 주고 창 프레임을 나중에 확정한다.** 그래서
/// 이벤트 시점에 잡아 둔 위치가 곧바로 밀린다 — "가끔 리사이즈하면 이상해진다"가
/// 이것이다 (도그푸딩 지적).
///
/// HuLa는 여기서 라이브 리사이즈 동안 60Hz로 최대 10초를 돈다. 우리는 **이벤트마다
/// 짧게 세 번**만 다시 잡는다: 끌고 있는 동안에는 이벤트가 계속 오므로 그 자체가
/// 폴링 역할을 하고, 손을 떼면 저절로 멈춘다. 상시 도는 태스크도, 끝낼 시점을
/// 정하는 문제도 없다.
fn apply_again_soon(window: &tauri::WebviewWindow) {
    for delay_ms in [16u64, 64, 200] {
        let w = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let inner = w.clone();
            // AppKit은 메인 스레드에서만 만질 수 있다
            let _ = w.run_on_main_thread(move || apply(&inner));
        });
    }
}

fn apply(window: &tauri::WebviewWindow) {
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    // SAFETY: Tauri가 준 포인터는 이 창의 NSWindow다. 창이 살아 있는 동안에만 쓴다.
    unsafe {
        let ns: &NSWindow = &*(ptr as *const NSWindow);
        place(ns);
    }
}

/// # Safety
/// `ns`는 살아 있는 NSWindow여야 하고, 메인 스레드에서만 불러야 한다.
unsafe fn place(ns: &NSWindow) {
    let Some(close) = ns.standardWindowButton(NSWindowButton::CloseButton) else { return };
    let Some(bar) = close.superview() else { return };

    let bar_h = bar.frame().size.height;
    let btn = close.frame();

    // AppKit 좌표는 왼쪽 **아래**가 원점이라, 위에서 y만큼 내리려면 뒤집어 계산한다
    let want_y = bar_h - (HEADER_H - btn.size.height) / 2.0 - btn.size.height;
    let dx = INSET_X - btn.origin.x;
    let dy = want_y - btn.origin.y;
    if dx.abs() < 0.5 && dy.abs() < 0.5 {
        return; // 이미 제자리 — 매 프레임 건드리지 않는다
    }

    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let Some(view) = ns.standardWindowButton(kind) else { continue };
        shift(&view, dx, dy);
    }
}

unsafe fn shift(view: &Retained<objc2_app_kit::NSButton>, dx: f64, dy: f64) {
    let mut f = view.frame();
    f.origin.x += dx;
    f.origin.y += dy;
    let v: &NSView = view;
    v.setFrameOrigin(f.origin);
}
