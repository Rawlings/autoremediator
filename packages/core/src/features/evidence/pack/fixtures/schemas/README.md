# Vendored JSON schemas (tests only)

Used by `evidence-pack.test.ts` to validate the documents the evidence pack writes, offline. They
are not shipped (only `dist` is published) and not imported by runtime code.

| File | Source |
| ---- | ------ |
| `bom-1.6.schema.json`, `spdx.schema.json`, `jsf-0.82.schema.json` | CycloneDX specification schemas as packaged in `@cyclonedx/cyclonedx-library@10.5.1` (`res/schema/*.SNAPSHOT.schema.json`, Apache-2.0). The only change is that the `$ref`s between them drop the `.SNAPSHOT` infix so they resolve against each file's `$id`. |
| `openvex-0.2.0.schema.json` | OpenVEX specification `openvex_json_schema.json` (`$id` ends `openvex_json_schema_0.2.0.json`, Apache-2.0), fetched from the `openvex/spec` repository. |
