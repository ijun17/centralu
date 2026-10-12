<!--
  Keep this short. The diff says what changed; this says why, and what you did not check.
  Delete any heading that does not apply rather than writing "N/A" under it.
-->

## Why

<!-- The problem, in a sentence or two. If an issue already argues it, link it and stop. -->

## What changed

<!-- The shape of the change. Not a file list — the diff has that. -->

## Verified

<!-- What you actually ran, and what it said. Numbers if you measured something:
     "9.4ms -> 0.275ms, 7-sample median" beats "faster". -->

## Usability

<!--
  If this changes something on screen: the discoverable paths' numbers before and after
  (`pnpm ux:report --compare <before.json> <after.json>`), and why for any budget raised.
  Otherwise write n/a and keep the heading, so a reviewer sees it was considered.
  How it is judged: docs/usability.md.
-->

## Not exercised

<!--
  Surfaces this change touches that you did not actually run. The packaged .app,
  Windows or Linux, live model sessions, a second physical machine, the release
  workflow, a cold install.

  "Nothing" is a valid answer when it is true. Reviewers read this field first,
  because it is the only one that tells them where to look themselves.
-->

## Closes

<!-- Closes #N. Or: no issue, small enough to go straight to a PR (CONTRIBUTING). -->
