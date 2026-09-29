# Security policy

## Reporting a vulnerability

Please **do not** report a security problem in a public issue, pull request or discussion.

Report it privately instead:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   ([direct link](https://github.com/ijun17/centralu/security/advisories/new)). Only the
   maintainer can read the report.
2. If you cannot use GitHub for this, email [ijun17@naver.com](mailto:ijun17@naver.com).

A useful report says:

- what the problem is and what an attacker could do with it
- the version you ran (the release tag, or the commit if you built from source) and your OS
- the steps to reproduce it, ideally with the smallest project, app or input that shows it

Centralu is maintained by one person. You can expect an acknowledgement within a week, and
updates until a fix ships. Once it is fixed, the advisory is published and you are credited,
unless you would rather not be.

## Supported versions

Centralu is in beta. Fixes go into the next release only, so please check the problem against
the latest release or `main` before reporting.

## Scope

[docs/security-boundaries.md](docs/security-boundaries.md) describes what Centralu promises to
keep apart, and the limits it states openly. A way around one of those promises is in scope. For
example:

- an app view that reaches the desktop app's commands, another app's view, or the host
- a repository you have not trusted whose files decide approvals or start an app
- an imported app, a zip or an app link that writes outside its folder, runs before you confirm
  it, or runs something other than what the review showed
- an app that uses an agent, another app or host data without the declaration and your answer
- an app's secret reaching anything but that app
- text from an app or another agent that is taken as your own instruction

Out of scope:

- what that document already lists as a limit, such as a trusted app's server running with your
  user's permissions
- vulnerabilities in Claude Code, Codex or other tools Centralu runs; report those to their makers
- problems that need an attacker who already controls your user account

## 한국어

보안 문제는 공개 이슈, PR, 토론에 올리지 마세요. 저장소의 **Security** 탭에서
**Report a vulnerability**로 알려 주세요
([바로 가기](https://github.com/ijun17/centralu/security/advisories/new)). 관리자만 볼 수 있습니다.
GitHub를 쓸 수 없으면 [ijun17@naver.com](mailto:ijun17@naver.com)으로 보내 주세요.
