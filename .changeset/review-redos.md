---
"autoremediator": patch
"@autoremediator/github-app": patch
---

Close several regular-expression denial-of-service paths and a few correctness gaps found in review.

- **Radar changelog parser**: every line is capped (1,000 characters) and so is the number of lines read, the security-heading pattern is linear, and negation and code-span checks scan each line once. A hostile changelog can no longer hang `radar` with padded or repeated-negation lines.
- **Radar negation**: a negation directly before a prevention verb ("do not allow prototype pollution", "don't allow path traversal") and "not only fixes XSS" now score as fixes instead of being dropped. Plain negation ("no security issues") still scores nothing.
- **Radar model prompt**: a literal `<untrusted>` or `</untrusted>` in package text is neutralised so it cannot close the data block early.
- **GitHub App log parser**: log lines are capped at 500 characters and the file-path patterns are anchored to the start of a path, so a long dot-free line no longer takes quadratic time.
- **Repair agent `searchCode`**: patterns over 200 characters or with a nested quantifier (such as `(a+)+`) are refused with a message telling the model to use a simpler pattern or a literal, and each searched line is capped at 500 characters.
- **Repair agent**: the limit of 5 memory proposals now holds for a whole attempt, not for each round.
- **Memory file**: a backtick fence whose info string contains a backtick (prose like `` ```npm test``` runs tests ``) is no longer taken as the start of a code block, which had hidden the real memory block and silently stopped pins from being enforced. A file that mentions the memory fence or heading but has no readable block now reports a problem.
