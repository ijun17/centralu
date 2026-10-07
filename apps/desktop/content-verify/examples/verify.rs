//! Verify a content folder and copy it, by hand:
//!
//!   cargo run --example verify -- <content dir> <new dest dir> <platform> [<public key, base64>]
//!
//! Without a key, the built-in keys (packaging/shell/keys.json) are used, which is what a shell
//! does. A key given here is for content signed by a dry run's throwaway key.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use content_verify::{embedded_keys, verify_and_copy, Expect, TrustedKey};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: verify <content dir> <new dest dir> <platform> [<public key, base64>]");
        std::process::exit(2);
    }
    let keys = match args.get(3) {
        Some(b64) => {
            vec![
                TrustedKey::from_raw("given", &STANDARD.decode(b64.trim()).expect("base64"))
                    .expect("key"),
            ]
        }
        None => embedded_keys().expect("built-in keys"),
    };
    let expect = Expect {
        platform: args[2].clone(),
        shell_version: None,
    };
    match verify_and_copy(Path::new(&args[0]), Path::new(&args[1]), &keys, &expect) {
        Ok(m) => println!(
            "ok: {} {}, {} files, key {}",
            m.app_version,
            m.platform,
            m.files.len(),
            m.key_id
        ),
        Err(e) => {
            eprintln!("refused: {e}");
            std::process::exit(1);
        }
    }
}
