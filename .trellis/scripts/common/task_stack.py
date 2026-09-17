#!/usr/bin/env python3
"""
Technology stack detection, gotchas, and cookbook guidance.

Provides:
    detect_stack           - Auto-detect project tech stack from repo files
    normalize_stack        - Normalize stack name from user input
    get_stack_guidance     - Retrieve gotchas, cookbook links, and research advice
    render_context_content - Render 01 context & requirements markdown
    render_todolist_content - Render 02 todolist markdown
    render_verification_content - Render 03 verification and comparison markdown
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional


STACK_PROFILES: Dict[str, Dict[str, Any]] = {
    "nextjs": {
        "name": "Next.js (React)",
        "gotchas": [
            "Server/Client Component Boundary: Keep components Server Components by default; only mark 'use client' at leaf interactive boundaries to preserve SSR/streaming benefits.",
            "Waterfalls & Async Fetching: Avoid serial awaits in child components; decouple data dependencies with Promise.all() or Suspense boundaries.",
            "Caching & Route Handlers: Next.js aggressively caches fetch requests and route handlers by default; explicitly configure { cache: 'no-store' } or revalidate tags when fresh data is required.",
            "Hydration Mismatches: Guard against browser-only APIs (window, localStorage) during SSR rendering.",
        ],
        "cookbooks": [
            "Next.js Official App Router Documentation: https://nextjs.org/docs/app",
            "Vercel React & Next.js Best Practices / Patterns",
        ],
    },
    "react": {
        "name": "React",
        "gotchas": [
            "State Mutation: Always treat state as immutable; avoid mutating objects/arrays in place before calling setState.",
            "Hook Dependency Drift: Ensure all referenced variables in useEffect/useCallback/useMemo are declared in dependencies or refactored with refs.",
            "Over-rendering & Context: Context updates re-render all subscribing components; split contexts or use selectors to avoid cascading re-renders.",
        ],
        "cookbooks": [
            "React Official Docs & Patterns: https://react.dev/reference/react",
        ],
    },
    "vue": {
        "name": "Vue.js",
        "gotchas": [
            "Reactivity Loss: Destructuring reactive objects without toRefs() breaks reactivity.",
            "Async State in Setup: Asynchronous calls inside setup() without Suspense can cause component mounting lifecycle race conditions.",
            "DOM Mutation Timing: Accessing DOM elements immediately after reactive state change requires await nextTick().",
        ],
        "cookbooks": [
            "Vue 3 Official Guide & Cookbook: https://vuejs.org/guide/introduction.html",
        ],
    },
    "node": {
        "name": "Node.js / TypeScript",
        "gotchas": [
            "Unhandled Async Errors: Always handle Promise rejections; unhandled errors crash the Node.js process in production.",
            "Event Loop Blocking: Never run CPU-intensive synchronous operations (regex backtracking, large JSON parsing) on the main event loop.",
            "Stream & Connection Leaks: Always handle stream 'error' and 'close' events; ensure HTTP agents and database connections are gracefully released.",
        ],
        "cookbooks": [
            "Node.js Best Practices: https://github.com/goldbergyoni/nodebestpractices",
            "TypeScript Strict Mode Handbook: https://www.typescriptlang.org/docs/handbook/intro.html",
        ],
    },
    "fastapi": {
        "name": "Python (FastAPI / Async)",
        "gotchas": [
            "Event Loop Blocking: Never call synchronous blocking I/O (e.g. requests.get, synchronous DB drivers) inside 'async def' endpoints; use anyio.to_thread.run_sync or native async clients (httpx).",
            "Dependency Lifecycle: Manage DB sessions and clients via FastAPI Depends(); do not share mutable session state across concurrent async requests.",
            "Pydantic V2 Migration: Use model_validate() instead of parse_obj(), and @field_validator instead of @validator.",
        ],
        "cookbooks": [
            "FastAPI Official Tutorial & Best Practices: https://fastapi.tiangolo.com/tutorial/",
            "AnyIO / Python AsyncIO Guidelines",
        ],
    },
    "django": {
        "name": "Python (Django)",
        "gotchas": [
            "N+1 Query Problem: Always inspect ORM query counts; use select_related() for single relations and prefetch_related() for collections.",
            "Database Transactions: Use transaction.atomic() with caution around external network requests; hold DB locks for the minimum necessary duration.",
            "Model Migration Drift: Never edit applied migration files directly without backward compatibility checks.",
        ],
        "cookbooks": [
            "Django Design Patterns and Best Practices",
            "Django Official Docs: https://docs.djangoproject.com/",
        ],
    },
    "python": {
        "name": "Python",
        "gotchas": [
            "Mutable Default Arguments: Never use mutable objects ([], {}) as function default argument values.",
            "Global State & Concurrency: Python GIL affects CPU-bound threads; use multiprocessing or async for concurrency instead of naive threading.",
            "Resource Cleanup: Always use context managers ('with' statements) for files, sockets, and locks.",
        ],
        "cookbooks": [
            "Python Design Patterns & Anti-patterns Guide",
            "Official Python Packaging & Typing Specs: https://peps.python.org/",
        ],
    },
    "rust": {
        "name": "Rust",
        "gotchas": [
            "Async Mutex vs Sync Mutex: Never hold a std::sync::MutexGuard across an '.await' point (causes deadlock/Send failures); use tokio::sync::Mutex or drop before await.",
            "Premature / Excessive Cloning: Avoid indiscriminate .clone(); design clean borrowing and ownership boundaries or Arc references.",
            "Channel Blocking: Bounded channels will block sender when full; always handle backpressure or select! timeout appropriately.",
        ],
        "cookbooks": [
            "Tokio Tutorial & Async Patterns: https://tokio.rs/tokio/tutorial",
            "Rust API Guidelines: https://rust-lang.github.io/api-guidelines/",
        ],
    },
    "go": {
        "name": "Go (Golang)",
        "gotchas": [
            "Goroutine Leak: Every started goroutine must have a deterministic exit condition via context.Context cancellation or channel closing.",
            "Concurrent Map Access: Reading and writing to a standard Go map concurrently causes fatal panic; use sync.RWMutex or sync.Map.",
            "Nil Pointer & Error Swallowing: Check errors explicitly immediately after return; do not ignore returned errors with blank identifier '_'.",
        ],
        "cookbooks": [
            "Effective Go: https://go.dev/doc/effective_go",
            "Uber Go Style Guide: https://github.com/uber-go/guide/blob/master/style.md",
        ],
    },
    "general": {
        "name": "General Engineering",
        "gotchas": [
            "Premature Optimization: Build the simplest working solution first; profile before adding complex caching or parallelization.",
            "Silent Error Suppression: Avoid broad catch/try blocks that swallow errors with fallback mock data; expose failures early.",
            "Missing Boundaries: Keep configuration and secrets out of source code; validate inputs at system boundaries.",
        ],
        "cookbooks": [
            "Glue Coding Philosophy: Prefer mature existing components and standard libraries over reinventing wheels.",
        ],
    },
}

# Alias mapping for user-provided --stack values
STACK_ALIASES: Dict[str, str] = {
    "next": "nextjs",
    "next.js": "nextjs",
    "nextjs": "nextjs",
    "react": "react",
    "vue": "vue",
    "vuejs": "vue",
    "node": "node",
    "nodejs": "node",
    "ts": "node",
    "js": "node",
    "typescript": "node",
    "javascript": "node",
    "express": "node",
    "fastify": "node",
    "nest": "node",
    "nestjs": "node",
    "python": "python",
    "py": "python",
    "fastapi": "fastapi",
    "django": "django",
    "flask": "python",
    "rust": "rust",
    "tokio": "rust",
    "go": "go",
    "golang": "go",
    "general": "general",
}


def normalize_stack(raw_name: Optional[str]) -> str:
    """Normalize user input or detected stack into canonical stack key."""
    if not raw_name:
        return "general"
    clean = raw_name.strip().lower()
    return STACK_ALIASES.get(clean, clean if clean in STACK_PROFILES else "general")


def detect_stack(repo_root: Path, package: Optional[str] = None) -> str:
    """Auto-detect project tech stack based on project files."""
    check_dirs = []
    if package:
        pkg_dir = repo_root / "packages" / package
        if pkg_dir.is_dir():
            check_dirs.append(pkg_dir)
    check_dirs.append(repo_root)

    for target_dir in check_dirs:
        # Check Rust
        if (target_dir / "Cargo.toml").is_file():
            return "rust"

        # Check Go
        if (target_dir / "go.mod").is_file():
            return "go"

        # Check Python
        py_files = ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py"]
        for pf in py_files:
            p_path = target_dir / pf
            if p_path.is_file():
                try:
                    text = p_path.read_text(encoding="utf-8", errors="ignore").lower()
                    if "fastapi" in text:
                        return "fastapi"
                    if "django" in text:
                        return "django"
                    return "python"
                except Exception:
                    return "python"

        # Check Node.js / Frontend
        pkg_json = target_dir / "package.json"
        if pkg_json.is_file():
            try:
                data = json.loads(pkg_json.read_text(encoding="utf-8"))
                deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
                if "next" in deps:
                    return "nextjs"
                if "react" in deps:
                    return "react"
                if "vue" in deps:
                    return "vue"
                return "node"
            except Exception:
                return "node"

    return "general"


def get_stack_guidance(stack_key: str) -> Dict[str, Any]:
    """Retrieve guidance profile for a given stack."""
    norm = normalize_stack(stack_key)
    return STACK_PROFILES.get(norm, STACK_PROFILES["general"])


def render_context_content(
    title: str,
    description: Optional[str],
    stack_key: str,
) -> str:
    """Render the background, requirements, and tech-stack research document."""
    heading = title.strip() or "Untitled Task"
    goal = (description or "").strip() or "TBD."
    guidance = get_stack_guidance(stack_key)
    stack_name = guidance.get("name", stack_key)
    gotchas = guidance.get("gotchas", [])
    cookbooks = guidance.get("cookbooks", [])

    gotchas_md = "\n".join(f"- ⚠️ **Gotcha**: {g}" for g in gotchas)
    cookbooks_md = "\n".join(f"- 📖 {c}" for c in cookbooks)

    return f"""# {heading}

## 1. Background & Requirements
- **Goal / Problem Statement**:
  {goal}
- **Target Tech Stack**: `{stack_name}`
- **Scope & Deliverables**:
  - Core deliverable 1
  - Core deliverable 2

---

## 2. Research & Mature Component Guidance (Thinking Before Coding)
> 💡 **Glue Coding Principle**: Prefer mature existing open-source libraries or standard modules over reinventing the wheel. Search before implementing!

- [ ] **Open-Source Investigation**: Has this problem already been solved by a reputable library or ecosystem package? (Search GitHub / npm / PyPI / Crates.io)
- [ ] **Architectural Reference**: How do battle-tested projects handle this pattern?
- **Selected Component / Library**: [Specify library name or write 'Standard Library / Custom Glue']
- **Rationale**: [Explain why this approach was chosen over raw custom implementation]

---

## 3. Tech Stack Gotchas & Anti-Patterns ({stack_name})
> ⚡️ Watch out for common pitfalls specific to this stack:
{gotchas_md}

## 4. Official Cookbooks & References
{cookbooks_md}

---

## 5. Acceptance Criteria
- [ ] Requirements implemented with surgical, high-cohesion changes
- [ ] Verified against edge cases with evidence documented in `verification.md`
- [ ] No regression or unhandled exceptions
"""


def render_todolist_content(title: str, description: Optional[str] = None) -> str:
    """Render a lightweight, actionable todolist."""
    heading = title.strip() or "Task"
    return f"""# {heading} - Todo List

> 📌 **Execution Guide**: Advance step by step. Keep changes surgical and verify each step.

- [ ] **Step 1: Planning & Research**
  - [ ] Review `prd.md` requirements and stack guidance
  - [ ] Search and identify mature libraries/patterns if applicable
- [ ] **Step 2: Core Implementation**
  - [ ] Implement minimal complete solution (glue coding)
  - [ ] Handle error boundaries and corner cases
- [ ] **Step 3: Verification & Evidence**
  - [ ] Run automated tests or smoke commands
  - [ ] Document before/after and output proof in `verification.md`
"""


def render_verification_content(title: str) -> str:
    """Render the verification, comparison, and evidence document."""
    heading = title.strip() or "Task"
    return f"""# {heading} - Verification & Comparison

## 1. Verification Plan
- **Test Commands**:
  ```bash
  # Run your test or smoke command here
  ```
- **Edge Cases Tested**:
  - [ ] Case 1: Normal path
  - [ ] Case 2: Boundary/Error condition

## 2. Before / After Comparison
| Dimension | Before (Original) | After (Updated) | Benefit / Impact |
| :--- | :--- | :--- | :--- |
| Behavior / Output | [Previous state] | [New verified state] | [Improvement] |
| Reliability / Speed | [Previous metric] | [New metric] | [Improvement] |

## 3. Real Execution Evidence
> 📋 Paste actual test runs, terminal logs, or assertion outputs below (strictly avoid mock data or swallowed errors):

```text
[Paste command output and test results here]
```
"""
