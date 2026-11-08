# Commit conventions

Every commit follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
The history is part of the product: it must say what changed, be searchable by
type, and remain safe to revert one task at a time.

## Subject

```
<type>(<scope>)?: <description>
```

- `type` is required and lowercase.
- `scope` is optional, lowercase, and names the affected stable area, such as
  `ui`, `agent-host`, `protocol`, `desktop`, or `docs`.
- `description` is imperative, lowercase, and has no trailing period.
- Keep the subject at 72 characters or fewer.
- Mark a breaking change with `!` before `:`: `feat(protocol)!: rename turn status`.

Use only these types:

| Type | Use for |
|---|---|
| `feat` | A user-visible capability |
| `fix` | Correcting broken behaviour |
| `refactor` | Internal restructuring with no intended behaviour change |
| `perf` | A measurable performance improvement |
| `test` | Adding or correcting tests only |
| `docs` | Documentation only |
| `style` | Formatting or visual-only work with no logic change |
| `build` | Build system or dependency changes |
| `ci` | Continuous-integration configuration |
| `chore` | Maintenance that fits none of the above |
| `revert` | Reverting an earlier commit |

Examples:

```
feat(ui): let the Assistant join grid
fix(ui): keep grid focus on the Assistant
docs: define conventional commit messages
refactor(ui): share the Assistant crown icon
```

## Body and footer

Add a body when the subject cannot fully explain the reason, trade-off, migration,
or verification boundary. Wrap prose at 72 characters. Explain why the change is
needed and what observable behaviour it establishes; do not duplicate a file list.

Use footers for issue references and compatibility notes:

```
Refs: #123
BREAKING CHANGE: stored sessions must be recreated.
```

The `BREAKING CHANGE:` footer is required when the subject did not already use
`!` and the public contract is incompatible.

## Commit boundaries

- One commit is one independently reviewable task.
- Include the tests that prove that task in the same commit.
- Do not mix generated output, formatting churn, or unrelated cleanup into a
  feature or fix. Give it its own commit when it must be kept.
- Amend or split local commits before pushing when a change crosses boundaries.
- Do not push a commit that fails the checks relevant to its scope.
