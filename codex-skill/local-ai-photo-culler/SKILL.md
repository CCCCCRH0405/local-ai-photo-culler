# Local AI Photo Culler

Use this skill when the user wants to clean up, triage, or review an Apple
Photos library with local AI while preserving privacy.

The workflow is:

1. Build the PhotoKit helper if needed:

```bash
npm run build:helper
```

2. Check/request Photos permission:

```bash
photo-cull auth
```

3. Run a conservative scan first:

```bash
photo-cull scan --limit 24 --level conservative
```

For screenshot cleanup:

```bash
photo-cull scan --screenshots-only --level medium --limit 50
```

4. Ask the user to review the generated `review.html`, select only photos they
are comfortable deleting, and export `selected-delete-ids.txt`.

5. Delete only after explicit user confirmation:

```bash
photo-cull delete --manifest <manifest.json> --ids-file selected-delete-ids.txt --yes
```

Safety rules:

- Never skip human review.
- Never use `--yes` unless the user explicitly confirms deletion.
- Prefer `conservative` for first runs.
- Remind the user that deletion moves photos to Apple Photos "Recently Deleted",
  which is recoverable for about 30 days.
- If `OLLAMA_BASE_URL` points away from `127.0.0.1` or `localhost`, warn the
  user that the privacy boundary has changed.
