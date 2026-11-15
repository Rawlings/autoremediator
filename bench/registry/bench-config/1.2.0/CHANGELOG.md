# Changelog

## 1.2.0

- Security: a missing key no longer leaks the contents of the config in its error message.
- Changed: `get` returns `undefined` for a missing key instead of throwing. Its type is now
  `string | undefined`.
