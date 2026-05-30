# Security Policy

## Supported Versions

The current `main` branch is the supported development version until the first
stable release.

## Privacy Boundary

By default, this project sends thumbnails only to the configured Ollama server.
For the intended local-only workflow, keep Ollama on:

```text
http://127.0.0.1:11434
```

If `OLLAMA_BASE_URL` points to another machine, the privacy boundary moves to
that machine.

## Reporting Issues

Please open a private security advisory or contact the maintainer before filing
public issues for:

- Accidental cloud data exposure.
- Deletion without explicit confirmation.
- Incorrect handling of Apple Photos identifiers.
- Path traversal or unsafe report generation.

Do not include private photos or manifests containing real local identifiers in
public reports.
