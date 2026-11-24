# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/noon-stucco7a/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/noon-stucco7a/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format: a Node 22 command-line tool that applies
AI-written edits — unified diffs (with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches and JSON editor calls — to a tree of text files.

Implements SPEC.md (the make.fun hidden-spec-cli-01 specification) in full:
three-tier line matching (exact, trailing-whitespace, indentation-drifted with
re-indentation), per-format parsing, and all-or-nothing application: every file
changes or none does.

Run it as `node main.ts [options] [PATCH]`; see SPEC.md in the competition kit
for the contract. In a trial, `main.ts` hands over to the kit's `runner.ts`
when `MAKEFUN_ENV_URL` is set.

Practice set: 100 of 100 checks passed locally (`node check.ts practice.json`,
practice score 1000).

License: MIT (see LICENSE).
