//! The public keys the keeper verifies content with (docs/plans/thin-shell.md §4): `packaging/shell/keys.json`,
//! compiled in through `content_verify::embedded_keys`, the same keys the shell trusts, and nothing else. Used for the
//! window's account of why the shell refused its content (`content::diagnose`). The test key a keeper build could also
//! trust went with the handoff to verified content it was for (#1895 step 4, PR 4).

use content_verify::{embedded_keys, TrustedKey};

/// The keys this build verifies content with.
pub fn trusted_keys() -> content_verify::Result<Vec<TrustedKey>> {
    embedded_keys()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keeper trusts exactly the keys in packaging/shell/keys.json, as the shell does.
    #[test]
    fn the_keeper_trusts_exactly_keys_json() {
        let ids = |keys: Vec<TrustedKey>| keys.into_iter().map(|k| (k.name, k.id)).collect::<Vec<_>>();
        let trusted = ids(trusted_keys().unwrap());
        assert_eq!(trusted, ids(embedded_keys().unwrap()));
        assert_eq!(trusted.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["current", "next"]);
    }
}
