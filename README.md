# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/midorima66/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/midorima66/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for makefun-site 1.0.0: `run(input)` returns exactly the reference program's output tree — every page's `index.html`, the index and tag pages, `build-report.txt` and each static file, byte for byte — several times faster. It reimplements makefun-site's own front matter, Markdown dialect, template dialect, slug rule and report with a fused single-pass Markdown renderer (range-based inline parsing, no substring copies), an ASCII fast path for slugs, per-build slug caches and an array-buffer template renderer.

## Run it

```sh
node main.ts
```

The driver reads every case from /input/cases.json and writes the answers to /output/answers.json (outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output).

---

<sub>Entered on [make.fun](https://make.fun/?ref=niccolo&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
