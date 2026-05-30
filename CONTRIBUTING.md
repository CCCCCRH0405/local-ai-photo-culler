# Contributing

Thanks for helping make private photo cleanup safer.

## Development

```bash
npm run build:helper
npm run check
```

Run small scans while testing:

```bash
node bin/photo-cull.js scan --limit 5 --level conservative
```

## Safety Bar

Changes that affect deletion behavior should be conservative by default:

- Never bypass human review.
- Never delete without an explicit `--yes`.
- Keep favorites protected.
- Prefer false negatives over false positives.
- Keep all cloud API calls out of the default workflow.

## Pull Requests

Please include:

- What changed.
- How you tested it.
- Whether the change affects candidate selection or deletion.
