//! Windows has no keeper yet (docs/plans/runtime-unification.md step 9), so a host is never frozen
//! or handed over there: these are the uninhabited stand-ins for `handover.rs`'s types, and a plain
//! line reader.

use std::io::{BufRead, BufReader};
use std::process::ChildStdout;

use super::Lines;

/// Nothing to pause: a host's stdout is never handed over here.
pub enum Gate {}

impl Clone for Gate {
    fn clone(&self) -> Gate {
        match *self {}
    }
}

/// A host another keeper handed over: none here, there is no keeper.
pub enum Foreign {}

impl Foreign {
    pub(super) fn id(&self) -> u32 {
        match *self {}
    }

    pub(super) fn stdin(&mut self) -> Option<&mut dyn std::io::Write> {
        match *self {}
    }

    pub(super) fn take_stdin(&mut self) -> Option<Box<dyn Send>> {
        match *self {}
    }

    pub(super) fn has_exited(&mut self) -> bool {
        match *self {}
    }

    pub(super) fn kill(&mut self) {
        match *self {}
    }

    pub(super) fn wait(&mut self) -> Option<i32> {
        match *self {}
    }
}

pub(super) fn host_lines(stdout: ChildStdout) -> (Lines, Option<Gate>) {
    (Box::new(BufReader::new(stdout).lines().map_while(Result::ok)), None)
}
