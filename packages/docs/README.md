# Autoremediator Docs App

This package hosts the documentation website implemented with Vite + React + TypeScript.

It is the source for published documentation at [https://rawlings.github.io/autoremediator/](https://rawlings.github.io/autoremediator/).

## Run Locally

```bash
pnpm dev
```

## Build

```bash
pnpm build
```

## GitHub Pages Deployment

The site is deployed by the repository workflow in `.github/workflows/docs-pages.yml`.

- Pull requests run a build-only validation for docs changes.
- Pushes to `main` build and deploy to GitHub Pages.
- In GitHub Actions, Vite uses the repository name as the base path (for this repo: `/autoremediator/`).
- Local builds keep the base path at `/`.

## Documentation Sources

The content displayed by the app is sourced from markdown files in `content/`:

- `content/getting-started.md`
- `content/cli.md`
- `content/scanner-inputs.md`
- `content/policy-and-safety.md`
- `content/api-sdk.md`
- `content/integrations.md`
- `content/contributor-guide.md`

## Published Documentation Index

- [Docs Home](https://rawlings.github.io/autoremediator/)
- [Getting Started](https://rawlings.github.io/autoremediator/docs/getting-started)
- [CLI Reference](https://rawlings.github.io/autoremediator/docs/cli)
- [Scanner Inputs](https://rawlings.github.io/autoremediator/docs/scanner-inputs)
- [Policy and Safety](https://rawlings.github.io/autoremediator/docs/policy-and-safety)
- [API and SDK](https://rawlings.github.io/autoremediator/docs/api-sdk)
- [Integrations](https://rawlings.github.io/autoremediator/docs/integrations)
- [Contributor Guide](https://rawlings.github.io/autoremediator/docs/contributor-guide)

## Documentation Quality Requirements

When editing docs pages, preserve reference depth:

- explain what the feature is
- explain why teams should use it
- explain how to apply it in automation workflows
- include security best-practice guidance
- include troubleshooting and cross-links to related pages

This keeps docs consistent for CI operators, platform engineers, and contributors.
