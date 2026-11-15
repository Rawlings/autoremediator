---
"autoremediator": patch
"autoremediator-rawlings": patch
---

Reposition around agentic remediation: from alert to a verified fix, with an agent that repairs the code an upgrade breaks and an independent verifier that decides what is kept.

- The package README (shown on npm and GitHub) is rewritten around that loop (plan, fix, repair, verify), with fewer code references, the guardrails that make an agent safe to hand the keys to, and the integrations and extra tools below the fold.
- The package, CLI, OpenAPI, GitHub Action, VS Code extension, Claude Code plugin and `llms.txt` descriptions, and the npm keywords, follow the same wording.
- The CLI text output now lists each package first (`✔ lodash 4.17.20 → 4.18.1 (version-bump, direct): fixed`, `○ … would fix (dry run)`, `✘ … not fixed, <reason>`) before the counters. JSON, SARIF and VEX output are unchanged.
