# Rollback points

Confirmed-good commits on `claude/dreamy-ramanujan-l3ozd4`. Git tags `rollback/NN-name` are created locally; tag pushes from the cloud sandbox currently fail (remote hangs up), so the SHA here is the source of truth. Recreate a tag with `git tag rollback/NN-name <sha>`.

| Tag | SHA | What was verified |
|---|---|---|
| rollback/00-baseline | 7d10b8f | Upstream v2.37.0, untouched. build, lint, 356 tests green (Node 22, sandbox); boot smoke OK with binary-check overrides. |
| rollback/01-upgrade-smoke | 65e983b | Baseline code plus upgrade smoke harness. lint clean, 356 tests, `npm run smoke:upgrade` passes (Node 22, sandbox). |
| rollback/02-ratchet | 83f2931 | Adds typescript-eslint, checkJs ratchet (7,576 errors / 206 files), MIGRATION.md. Local: build, lint, 356 tests, ratchet, smoke:upgrade pass. GitHub CI: all 5 workflows green on this SHA (Node 24). |
| rollback/03-characterization | 68a0c30 | All 23 controllers characterized (967 tests, 6 skipped), harness hardened. Local: build, lint, 967 tests x4 identical, ratchet, smoke:upgrade pass. GitHub CI: Unit Tests, Upgrade Smoke, Ratchet, Integration all green on this SHA. |
| rollback/04-audit-guard | c85c3f2 | Tie-proof harness, characterization audit, oracle manifest + CI guard, Sequelize-declare lint rule. Local: build, lint, 968 tests, ratchet, smoke:upgrade, audit pass. GitHub CI: all 6 workflows green on this SHA. |
