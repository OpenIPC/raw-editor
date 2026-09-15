# CLAUDE.md

Read [CONTRIBUTING.md](CONTRIBUTING.md). It is written for anyone changing this
tree and everything in it applies here — the build loop, the committed `dist/`,
the freestanding engine, the fixtures, and a list of traps this repository has
already fallen into. That list is the valuable part; several of the entries are
mistakes made by an assistant working in this tree, and repeating them is easy.

A few things worth restating because they are easy to skip:

- **Run the whole loop before reporting a change as done.** `./tools/build.sh`,
  then the `dist/` diff, then `tools/smoke.mjs` and `tools/ui-check.mjs`. The
  `dist/` diff in particular fails for changes that look finished, because
  `dist/` is committed and is what the CDN serves.
- **Watch a new test fail before you trust it.** A guard added alongside its fix
  has never been observed doing anything. Revert the fix, see it go red, put the
  fix back.
- **Every number you write down should be one you took.** Timings, counts, memory
  figures — measured on something named, not estimated. If a figure came from
  elsewhere, say where.
- **Check a claim against the tree rather than from memory** before putting it in
  a comment, a commit message or a document. Several statements in this
  repository's own docs had gone stale and were found that way.
