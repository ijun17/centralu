//! The downgrade floor.

mod common;

use common::Temp;
use content_verify::version::{
    check_not_downgrade, read_highest_seen, record_started, Rollback, Version,
};
use content_verify::Error;

/// Strictly increasing, the SemVer 2.0 §11 example extended with this project's beta numbering,
/// where `beta.11` must sort after `beta.2` (numerically, not as text).
const ORDERED: &[&str] = &[
    "0.0.9",
    "0.1.0-alpha",
    "0.1.0-alpha.1",
    "0.1.0-alpha.beta",
    "0.1.0-beta",
    "0.1.0-beta.2",
    "0.1.0-beta.9",
    "0.1.0-beta.10",
    "0.1.0-beta.11",
    "0.1.0-rc.1",
    "0.1.0",
    "0.1.1",
    "0.2.0",
    "0.10.0",
    "1.0.0",
    "10.0.0",
];

#[test]
fn versions_order_as_semver_says() {
    for (i, a) in ORDERED.iter().enumerate() {
        for (j, b) in ORDERED.iter().enumerate() {
            let (va, vb) = (Version::parse(a).unwrap(), Version::parse(b).unwrap());
            assert_eq!(va.cmp(&vb), i.cmp(&j), "{a} vs {b}");
        }
    }
}

#[test]
fn malformed_versions_are_refused() {
    for v in [
        "",
        "1",
        "1.2",
        "1.2.3.4",
        "01.2.3",
        "1.02.3",
        "1.2.03",
        "v1.2.3",
        "1.2.3-",
        "1.2.3-a..b",
        "1.2.3-01",
        "1.2.3+b",
        "1.2.3-a+b",
        " 1.2.3",
        "1.2.3 ",
        "-1.2.3",
        "1.2.x",
        "1.2.3-a_b",
    ] {
        assert!(
            matches!(Version::parse(v), Err(Error::BadVersion(_))),
            "{v:?}"
        );
    }
}

#[test]
fn a_lower_version_is_refused_unless_rolling_back_on_purpose() {
    for (i, cand) in ORDERED.iter().enumerate() {
        for (j, high) in ORDERED.iter().enumerate() {
            let refused = check_not_downgrade(cand, Some(high), Rollback::Refuse);
            assert_eq!(refused.is_err(), i < j, "{cand} after {high}");
            if i < j {
                assert!(matches!(refused, Err(Error::Downgrade { .. })));
            }
            assert!(check_not_downgrade(cand, Some(high), Rollback::Allow).is_ok());
        }
        assert!(check_not_downgrade(cand, None, Rollback::Refuse).is_ok());
    }
}

#[test]
fn the_floor_only_rises_and_a_rollback_sets_it_on_purpose() {
    let t = Temp::new("floor");
    let f = t.join("highest-version");
    assert_eq!(read_highest_seen(&f).unwrap(), None);
    record_started(&f, "0.1.0-beta.10", Rollback::Refuse).unwrap();
    record_started(&f, "0.1.0-beta.9", Rollback::Refuse).unwrap();
    assert_eq!(
        read_highest_seen(&f).unwrap().as_deref(),
        Some("0.1.0-beta.10")
    );
    record_started(&f, "0.1.0-beta.11", Rollback::Refuse).unwrap();
    assert_eq!(
        read_highest_seen(&f).unwrap().as_deref(),
        Some("0.1.0-beta.11")
    );
    // The window asked for beta.9: the next start after a reboot must not refuse it.
    record_started(&f, "0.1.0-beta.9", Rollback::Allow).unwrap();
    assert_eq!(
        read_highest_seen(&f).unwrap().as_deref(),
        Some("0.1.0-beta.9")
    );
    assert!(check_not_downgrade("0.1.0-beta.9", Some("0.1.0-beta.9"), Rollback::Refuse).is_ok());
    let left: Vec<_> = std::fs::read_dir(t.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left.len(), 1, "a temporary file was left: {left:?}");
}

#[test]
fn a_corrupt_floor_is_an_error_not_a_reset() {
    let t = Temp::new("corrupt");
    let f = t.join("highest-version");
    std::fs::write(&f, "garbage").unwrap();
    assert!(read_highest_seen(&f).is_err());
    assert!(record_started(&f, "9.9.9", Rollback::Refuse).is_err());
}
