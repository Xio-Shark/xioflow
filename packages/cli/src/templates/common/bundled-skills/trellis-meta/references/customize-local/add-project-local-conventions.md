# Add Project-Local Conventions

Often the user does not need to change Trellis mechanics; they need local AI to understand their team's conventions. In that case, prefer `.xioflow/spec/` or a project-local skill instead of editing `trellis-meta`.

## Where To Put Things

| Content type | Location |
| --- | --- |
| Rules code must follow | `.xioflow/spec/<layer>/` |
| Cross-layer thinking methods | `.xioflow/spec/guides/` |
| AI capability for a project-specific flow | Platform-local skill |
| One-off task material | `.xioflow/tasks/<task>/` |
| Session summary | `.xioflow/workspace/<developer>/journal-N.md` |

## Create A Project-Local Skill

If the user wants AI to know "how this project customizes Trellis," create a local skill:

```text
.claude/skills/trellis-local/
└── SKILL.md
```

Example:

```md
---
name: trellis-local
description: "Project-local Trellis customizations for this repository. Use when changing this project's Trellis workflow, hooks, local agents, or team-specific conventions."
---

# Trellis Local

## Local Scope

This skill documents this repository's Trellis customizations only.

## Custom Workflow Rules

- ...

## Local Hook Changes

- ...

## Local Agent Changes

- ...
```

For multi-platform projects, place equivalent versions in other platform skill directories, or use `.agents/skills/` for platforms that support the shared layer.

## Write To `.xioflow/spec/`

If the content is a coding convention, write it to spec. Examples:

```text
.xioflow/spec/backend/error-handling.md
.xioflow/spec/frontend/components.md
.xioflow/spec/guides/cross-platform-thinking-guide.md
```

After writing it, update the corresponding `index.md` so AI can find the new rule from the entry point.

## Make The Current Task Use New Conventions

After writing a spec, add it to the current task context:

```bash
python3 ./.xioflow/scripts/task.py add-context <task> implement ".xioflow/spec/backend/error-handling.md" "Error handling conventions"
python3 ./.xioflow/scripts/task.py add-context <task> check ".xioflow/spec/backend/error-handling.md" "Review error handling"
```

## Do Not Store Project-Private Rules In `trellis-meta`

`trellis-meta` is a public skill for understanding Trellis architecture and local customization entry points. Put project-private content in:

- `.xioflow/spec/`
- a project-local skill
- the current task
- workspace journal

This prevents future updates to Trellis's built-in `trellis-meta` from overwriting the team's own conventions.
