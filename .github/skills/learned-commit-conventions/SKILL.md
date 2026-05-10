---
name: learned-commit-conventions
description: "[Auto-generated] Commit message conventions for the email-tracker repo. Use when authoring any git commit so the message matches the existing 25-commit history."
---

# Commit Conventions (Learned)

> **Auto-generated** by `/evolve` from `.atv/instincts/project.yaml` on 2026-05-10.
> Source instinct: `conventional-commit-prefixes` (confidence 0.95, 25 observations).
> Edit freely — this is a starting point.

## When to Apply

Whenever you author a git commit in this repo. The commit message format is uniform across all 25 commits in `git log --oneline -25` and should be preserved.

## Format

```
<type>(<scope>): <subject>

<optional body — explains *why*, wraps at ~72 chars>

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

### Type (required)

One of: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. Lowercase.

| Type | Use for |
|---|---|
| `feat` | New user-visible capability |
| `fix` | Bug fix |
| `refactor` | Code change that doesn't add features or fix bugs |
| `docs` | Documentation only (incl. `docs/solutions/`, READMEs, code comments) |
| `test` | Test additions or fixes only |
| `chore` | Build, deps, tooling, or repo-housekeeping changes |

### Scope (required for code commits, optional for docs/chore)

A short identifier in parentheses indicating the affected area. Observed scopes:

- Workspaces: `extension`, `functions`, `dashboard`
- Subsystems: `pixel`, `notify`, `classifier`, `poller`, `auth`, `api`
- Infra: `netlify`, `deploy`, `atv`

Multi-area commits use comma-separated scopes: `fix(notify,classifier): ...`.

### Subject (required)

- Lowercase imperative (`add`, `fix`, `remove` — not `added`/`adds`/`fixing`)
- No trailing period
- Aim for ≤ 72 chars
- The subject completes the sentence "If applied, this commit will [subject]"

### Body (optional, recommended for non-trivial commits)

- Wrap at ~72 chars
- Focus on **why**, not what (the diff shows what)
- Use `-` bullets for lists
- Reference commit SHAs, file paths, doc paths inline

### Co-author trailer (always)

`Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

This is mandated by the agent runtime and is included in every commit.

## Examples (drawn from real history)

**Feature commit:**
```
feat(extension): self-view beacon for own-thread suppression (U6c)
```

**Bug fix with multi-scope:**
```
fix(notify,classifier): proper text[] parsing + Google-proxy classification
```

**Test-only:**
```
test(functions): pull supabase keys dynamically, scrub literal secret
```

**Docs only:**
```
docs(solutions): capture Step 8 production-deploy learnings
```

**Refactor:**
```
refactor(extension): parameterize API base out of source tree
```

**Chore (tooling):**
```
chore(atv): seed project instincts from Step 8 deploy session
```

## When in Doubt

Run `git --no-pager log --oneline -25` and match the closest precedent. The repo is small enough that grepping prior commit subjects for the same scope usually reveals the right pattern.

## Evidence

This skill graduated from the `conventional-commit-prefixes` instinct after observation in 25 consecutive commits. Sample SHAs: `5f3f999`, `bcffb64`, `358e36a`, `80ef5e7`, `f3457a9`, `6e99339`, `27721b1`, `a65f2bd`, `390476e`, `6084f63`, `3d6b04e`, `89e173d`, `eeeedd7`, `d83270e`, `740f359`, `ec8189c`, `3ee62e4`, `8c97ead`, `065d303`, `a8d93ae`, `1a3e931`, `bb35e70`, `5e8bd4c`.
