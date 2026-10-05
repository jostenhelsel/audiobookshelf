# Rollback points

Confirmed-good commits on `claude/dreamy-ramanujan-l3ozd4`. Git tags `rollback/NN-name` are created locally; tag pushes from the cloud sandbox currently fail (remote hangs up), so the SHA here is the source of truth. Recreate a tag with `git tag rollback/NN-name <sha>`.

| Tag | SHA | What was verified |
|---|---|---|
| rollback/00-baseline | 7d10b8f | Upstream v2.37.0, untouched. build, lint, 356 tests green (Node 22, sandbox); boot smoke OK with binary-check overrides. |
