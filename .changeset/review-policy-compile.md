---
"autoremediator": patch
---

`policy compile` and `findLoosenings` review fixes.

- A loosening now needs words in your request that are about that very key, matched as whole words
  (so "package" no longer counts as "age" or "allow" as "low"), and a phrase the request negates
  ("Never allow major bumps") no longer counts as asking for it. Quoted phrases must be consecutive
  words of the request and about the keys they explain; a suppression is only accepted for an advisory
  id the request spells out.
- `findLoosenings` / `isLoosening` also report `trustMaintainerVex` turned on, lowered
  `patchConfidenceThresholds`, a smaller `autonomy.window` and looser `freshness` limits, and a test
  now fails when a policy key is added without being classified.
- `policy compile --yes` keeps a CRLF policy file CRLF instead of rewriting it with LF.
