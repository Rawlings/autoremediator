# Changelog

## 1.5.0

- Security: fixes a formatting bug that could produce attacker-controlled output for crafted amounts.
- Changed: the default thousands separator is now a narrow no-break space (U+202F), so output is
  locale-neutral. Pass `{ separator: "," }` to keep the previous output.
- Added: the `options` argument of `format`.
