//! Native path handoff checks for path-based OS side effects.

use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum NativePathError {
    NonAbsolute(PathBuf),
    ParentTraversal(PathBuf),
    Metadata { path: PathBuf, message: String },
    SymlinkComponent(PathBuf),
}

impl fmt::Display for NativePathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonAbsolute(path) => write!(f, "path is not absolute: {}", path.display()),
            Self::ParentTraversal(path) => {
                write!(f, "path contains parent traversal: {}", path.display())
            }
            Self::Metadata { path, message } => {
                write!(
                    f,
                    "could not inspect path component {}: {message}",
                    path.display()
                )
            }
            Self::SymlinkComponent(path) => {
                write!(f, "path component is a symbolic link: {}", path.display())
            }
        }
    }
}

pub fn assert_safe_native_path(path: &Path) -> Result<(), NativePathError> {
    if !path.is_absolute() {
        return Err(NativePathError::NonAbsolute(path.to_path_buf()));
    }

    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(NativePathError::ParentTraversal(path.to_path_buf()));
            }
            Component::Normal(name) => {
                current.push(name);
                let metadata = std::fs::symlink_metadata(&current).map_err(|error| {
                    NativePathError::Metadata {
                        path: current.clone(),
                        message: error.to_string(),
                    }
                })?;
                if metadata.file_type().is_symlink() {
                    return Err(NativePathError::SymlinkComponent(current));
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{assert_safe_native_path, NativePathError};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must be after unix epoch")
                .as_nanos();
            let raw_root = std::env::temp_dir().join(format!(
                "centralu-path-safety-{name}-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&raw_root).expect("test temp root should be created");
            let root = raw_root
                .canonicalize()
                .expect("test temp root should canonicalize away system symlink prefixes");
            Self { root }
        }

        fn path(&self) -> &Path {
            &self.root
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn rejects_nonabsolute_path_when_native_handoff_is_validated() {
        // Given: a relative path supplied to a native side-effect command.
        let path = Path::new("relative/file.txt");

        // When: the native handoff validator runs.
        let result = assert_safe_native_path(path);

        // Then: the command boundary rejects it before any OS side effect.
        assert!(matches!(result, Err(NativePathError::NonAbsolute(_))));
    }

    #[test]
    fn rejects_parent_traversal_when_absolute_path_is_validated() {
        // Given: an absolute path string that still contains a parent traversal component.
        let temp = TempTree::new("parent-traversal");
        let path = temp.path().join("..").join("outside.txt");

        // When: the native handoff validator runs.
        let result = assert_safe_native_path(&path);

        // Then: the command boundary rejects the traversal syntax.
        assert!(matches!(result, Err(NativePathError::ParentTraversal(_))));
    }

    #[test]
    fn accepts_ordinary_file_when_canonical_absolute_path_is_validated() {
        // Given: an ordinary file addressed by an absolute canonical path.
        let temp = TempTree::new("ordinary-file");
        let path = temp.path().join("file.txt");
        fs::write(&path, b"ok").expect("test file should be written");
        let canonical = path.canonicalize().expect("test file should canonicalize");

        // When: the native handoff validator runs.
        let result = assert_safe_native_path(&canonical);

        // Then: the command boundary accepts it.
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn accepts_ordinary_directory_when_canonical_absolute_path_is_validated() {
        // Given: an ordinary directory addressed by an absolute canonical path.
        let temp = TempTree::new("ordinary-directory");
        let path = temp.path().join("dir");
        fs::create_dir(&path).expect("test directory should be created");
        let canonical = path
            .canonicalize()
            .expect("test directory should canonicalize");

        // When: the native handoff validator runs.
        let result = assert_safe_native_path(&canonical);

        // Then: the command boundary accepts it.
        assert_eq!(result, Ok(()));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_final_symlink_when_native_handoff_is_validated() {
        // Given: an absolute path whose final component is a symlink.
        let temp = TempTree::new("final-symlink");
        let target = temp.path().join("target.txt");
        let link = temp.path().join("link.txt");
        fs::write(&target, b"target").expect("test target should be written");
        std::os::unix::fs::symlink(&target, &link).expect("test symlink should be created");

        // When: the native handoff validator runs.
        let result = assert_safe_native_path(&link);

        // Then: the command boundary rejects the symlink before any OS side effect.
        assert!(matches!(result, Err(NativePathError::SymlinkComponent(path)) if path == link));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_intermediate_symlink_when_native_handoff_is_validated() {
        // Given: an absolute path whose intermediate directory component is a symlink.
        let temp = TempTree::new("intermediate-symlink");
        let outside = temp.path().join("outside");
        let pivot = temp.path().join("pivot");
        fs::create_dir(&outside).expect("test outside directory should be created");
        fs::write(outside.join("file.txt"), b"outside")
            .expect("test outside file should be written");
        std::os::unix::fs::symlink(&outside, &pivot).expect("test symlink should be created");
        let path = pivot.join("file.txt");

        // When: the native handoff validator runs.
        let result = assert_safe_native_path(&path);

        // Then: the command boundary rejects the symlinked intermediate component.
        assert!(matches!(result, Err(NativePathError::SymlinkComponent(path)) if path == pivot));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_final_symlink_when_native_handoff_is_validated() {
        // Given: an absolute path whose final component is a dangling symlink.
        let temp = TempTree::new("dangling-final-symlink");
        let missing = temp.path().join("missing.txt");
        let link = temp.path().join("dangling.txt");
        std::os::unix::fs::symlink(&missing, &link)
            .expect("test dangling symlink should be created");

        // When: the native handoff validator runs.
        let result = assert_safe_native_path(&link);

        // Then: the command boundary rejects the symlink, not the missing target.
        assert!(matches!(result, Err(NativePathError::SymlinkComponent(path)) if path == link));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_directory_swapped_to_symlink_after_earlier_validation() {
        // Given: an ordinary path that passed an earlier validation.
        let temp = TempTree::new("swapped-intermediate");
        let outside = temp.path().join("outside");
        let pivot = temp.path().join("pivot");
        fs::create_dir(&outside).expect("test outside directory should be created");
        fs::create_dir(&pivot).expect("test pivot directory should be created");
        let path = pivot.join("file.txt");
        fs::write(&path, b"inside").expect("test inside file should be written");
        assert_eq!(assert_safe_native_path(&path), Ok(()));

        // When: the directory is replaced by a symlink during the async web/RPC delay.
        fs::remove_file(&path).expect("test inside file should be removed");
        fs::remove_dir(&pivot).expect("test pivot directory should be removed");
        std::os::unix::fs::symlink(&outside, &pivot).expect("test symlink swap should be created");
        let result = assert_safe_native_path(&path);

        // Then: the just-before-use native validator rejects the swapped component.
        assert!(
            matches!(result, Err(NativePathError::SymlinkComponent(component)) if component == pivot)
        );
    }
}
