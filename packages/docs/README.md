# Autoremediator Docs App

This package hosts the documentation website implemented with Vite + React + TypeScript.

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

The content displayed by the app is sourced from markdown files in this directory:

- `getting-started.md`
- `cli.md`
- `scanner-inputs.md`
- `policy-and-safety.md`
- `api-sdk.md`
- `integrations.md`
- `migration-from-npm.md`
- `contributor-guide.md`
