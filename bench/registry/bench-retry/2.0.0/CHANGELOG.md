# Changelog

## 2.0.0

- Security: the delay is now capped, closing a resource-exhaustion issue.
- Breaking: `retry(fn, attempts, delayMs)` is now `retry(fn, { attempts, delayMs })`. The default is
  one attempt.
