# Rollback points

Confirmed-good commits on `claude/dreamy-ramanujan-l3ozd4`. Git tags `rollback/NN-name` are created locally; tag pushes from the cloud sandbox currently fail (remote hangs up), so the SHA here is the source of truth. Recreate a tag with `git tag rollback/NN-name <sha>`.

| Tag | SHA | What was verified |
|---|---|---|
| rollback/00-baseline | 7d10b8f | Upstream v2.37.0, untouched. build, lint, 356 tests green (Node 22, sandbox); boot smoke OK with binary-check overrides. |
| rollback/01-upgrade-smoke | 65e983b | Baseline code plus upgrade smoke harness. lint clean, 356 tests, `npm run smoke:upgrade` passes (Node 22, sandbox). |
| rollback/02-ratchet | 83f2931 | Adds typescript-eslint, checkJs ratchet (7,576 errors / 206 files), MIGRATION.md. Local: build, lint, 356 tests, ratchet, smoke:upgrade pass. GitHub CI: all 5 workflows green on this SHA (Node 24). |
