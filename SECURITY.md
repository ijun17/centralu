# Security policy

## Reporting a vulnerability

**While Centralu is in beta, a public issue or pull request is fine.** Centralu has few users
yet, and a problem fixed in the open helps more than one waiting in a private queue. Open an
issue (or a pull request with the fix) as you would for any bug, and say in the title that it is
a security problem.

This changes before the first stable release (1.0): from then on, security problems are reported
privately only.

If you would rather report privately now, that works too:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   ([direct link](https://github.com/ijun17/centralu/security/advisories/new)). Only the
   maintainer can read the report.
2. If you cannot use GitHub for this, email [ijun17@naver.com](mailto:ijun17@naver.com).

Please keep it private if the problem lets someone run code on, or read files from, another
person's machine without any action from them; report that one privately even during the beta.

A useful report says:

- what the problem is and what an attacker could do with it
- the version you ran (the release tag, or the commit if you built from source) and your OS
- the steps to reproduce it, ideally with the smallest project, app or input that shows it

Centralu is maintained by one person. You can expect an acknowledgement within a week, and
updates until a fix ships. A private report's advisory is published once it is fixed, and you
are credited, unless you would rather not be.

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

베타 기간에는 보안 문제도 공개 이슈나 PR로 올려 주셔도 됩니다. 제목에 보안 문제라고 적어 주세요.
정식 출시(1.0)부터는 비공개로만 받습니다. 지금도 비공개로 알리고 싶다면 저장소의 **Security** 탭에서
**Report a vulnerability**로 알려 주세요
([바로 가기](https://github.com/ijun17/centralu/security/advisories/new)). 관리자만 볼 수 있습니다.
GitHub를 쓸 수 없으면 [ijun17@naver.com](mailto:ijun17@naver.com)으로 보내 주세요.
다만 다른 사람의 컴퓨터에서 아무 동작 없이 코드를 실행하거나 파일을 읽을 수 있는 문제는 베타 기간에도
비공개로 알려 주세요.
