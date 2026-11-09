# 커밋 컨벤션

모든 커밋은 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)을 따른다.
히스토리는 제품의 일부다. 무엇이 바뀌었는지 말하고, 타입으로 검색할 수 있으며,
작업 하나 단위로 안전하게 되돌릴 수 있어야 한다.

## 제목

```
<type>(<scope>)?: <description>
```

- `type`은 필수이며 소문자로 쓴다.
- `scope`은 선택 사항이며 소문자로 쓴다. `ui`, `agent-host`, `protocol`,
  `desktop`, `docs`처럼 안정적인 영향 영역의 이름을 쓴다.
- `description`은 명령형 소문자로 쓰고 마침표를 붙이지 않는다.
- 제목은 72자 이하여야 한다.
- 호환성을 깨는 변경은 `:` 앞에 `!`를 붙인다.
  예: `feat(protocol)!: rename turn status`.

허용하는 `type`은 다음뿐이다.

| Type | 쓸 때 |
|---|---|
| `feat` | 사용자가 체감하는 기능 |
| `fix` | 깨진 동작 수정 |
| `refactor` | 의도한 동작 변화 없는 내부 구조 변경 |
| `perf` | 측정 가능한 성능 개선 |
| `test` | 테스트만 추가하거나 수정할 때 |
| `docs` | 문서만 바꿀 때 |
| `style` | 로직 변화 없는 포맷·시각 변경 |
| `build` | 빌드 시스템·의존성 변경 |
| `ci` | 지속적 통합 설정 |
| `chore` | 위 어디에도 맞지 않는 유지보수 |
| `revert` | 이전 커밋 되돌리기 |

예시:

```
feat(ui): let the Assistant join grid
fix(ui): keep grid focus on the Assistant
docs: define conventional commit messages
refactor(ui): share the Assistant crown icon
```

## 본문과 푸터

제목만으로 이유, 트레이드오프, 이관, 검증 경계를 설명할 수 없으면 본문을 쓴다.
본문은 72자에서 줄바꿈한다. 파일 목록을 되풀이하지 말고, 왜 필요한 변경인지와
어떤 관찰 가능한 동작을 만드는지 적는다.

이슈 참조와 호환성 메모는 푸터로 적는다.

```
Refs: #123
BREAKING CHANGE: stored sessions must be recreated.
```

제목에 `!`를 쓰지 않았고 공개 계약이 호환되지 않으면
`BREAKING CHANGE:` 푸터를 반드시 쓴다.

## 커밋 경계

- 커밋 하나는 독립적으로 리뷰할 수 있는 작업 하나다.
- 그 작업을 증명하는 테스트는 같은 커밋에 넣는다.
- 생성물, 포맷 변경, 관계없는 정리를 기능·수정 커밋에 섞지 않는다. 남겨야 하면
  별도 커밋으로 둔다.
- 변경이 경계를 넘으면 푸시 전에 로컬 커밋을 고치거나 나눈다.
- 범위에 맞는 검증을 통과하지 못한 커밋은 푸시하지 않는다.
