---
"autoremediator": minor
---

Policy in plain language: `autoremediator policy compile "<rules>"` and `autoremediator policy explain`.

- **`policy compile`** turns rules such as "Never auto-merge majors; KEV fixes within 24 hours; don't
  touch left-pad" into a validated diff of `.github/autoremediator.yml` for review. A model proposes a
  structured patch over an allowlist of policy keys; deterministic code applies it with the file's
  comments kept, validates it with the policy loader, requires every change to be explained by quoted
  words of the request, lists what the policy cannot express (such as "in payments") instead of
  approximating it, and refuses any loosening (`findLoosenings` / `isLoosening`) that the request does
  not ask for or that `--allow-loosening` does not accept. Nothing is written without `--yes` or a
  confirmation at a terminal; without a terminal it exits 3. Needs a model (`--model` or
  `AUTOREMEDIATOR_MODEL`).
- **`policy explain`** reads the policy back as plain sentences, deterministically and with no model.
- New operations `compilePolicy` (proposal only over MCP and HTTP, never writes) and `explainPolicy`
  on every surface: MCP tools, `POST /policy/compile`, `POST /policy/explain`, CLI and the SDK
  (`compilePolicy`, `writePolicyProposal`, `explainPolicy`, `findLoosenings`, `isLoosening`).
- New guide `docs/guides/policy-in-plain-language.md`.
