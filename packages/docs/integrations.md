# Integrations

## MCP

```bash
autoremediator-mcp
```

Tools exposed:

- `remediate`
- `remediateFromScan`

## OpenAPI

```bash
node dist/openapi/server.js --port 3000
```

Routes:

- `POST /remediate`
- `POST /remediate-from-scan`
- `GET /openapi.json`
- `GET /health`

## CI

```bash
autoremediator ./audit.json --ci --summary-file ./summary.json
```
