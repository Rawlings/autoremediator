# Contributing to Autoremediator

Thanks for contributing.

This project values clear documentation, deterministic behavior, and safe defaults.

## Quick Start

Prerequisites:

- Node.js 18+
- pnpm (recommended)
- Git

Clone and install:

```bash
git clone https://github.com/rawlings/autoremediator.git
cd autoremediator
pnpm install
```

Build and validate:

```bash
pnpm build
pnpm typecheck
pnpm test
```

npm/yarn alternatives are supported, but pnpm is the preferred contributor workflow.

## Contribution Principles

- Prefer small, focused changes.
- Preserve stable behavior unless a change is intentional and documented.
- Favor deterministic workflows and explicit safety checks.
- Keep user-facing behavior and contributor guidance aligned.

## Governance Expectations

When behavior, interfaces, or execution rules change, update the related governance and documentation in the same pull request.

Keep naming, schemas, and terminology consistent across all supported interfaces.

If a change affects users or operators, ensure both usage docs and contributor guidance are updated together.

## Default Workflow

Contributions should follow this default path:

1. Define scope and acceptance criteria before implementation.
2. Implement with a consolidation-first mindset.
3. Add or update tests that verify behavior and safety.
4. Update supporting docs and governance notes to match.

This process is advisory-first by default (warn-first), but still required for completeness.

## Pull Request Checklist

- Build passes
- Typecheck passes
- Tests pass (unless the change is docs-only)
- Docs updated for any user-facing or contributor-facing behavior change
- Governance instructions and skills updated when execution behavior changes
- Required update bundle completed for the scope of the change
