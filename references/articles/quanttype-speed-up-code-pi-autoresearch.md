# Speed Up Code with pi-autoresearch

- **Author:** Miikka Koskinen
- **Published:** 2026 (exact date not specified)
- **URL:** https://quanttype.net/p/speed-up-code-with-pi-autoresearch/

## Summary

Miikka Koskinen describes using pi-autoresearch (a plugin for the Pi coding agent) to optimize code performance, with a concrete case study on jsonista, a Clojure JSON serialization library.

### What is pi-autoresearch?
A plugin for the Pi coding agent that implements the autoresearch loop for any numeric target: benchmark results, build size, compression ratio, etc. Setup:

```
npm install -g @mariozechner/pi-coding-agent
pi install https://github.com/davebcn87/pi-autoresearch
```

Initialize with `/skill:autoresearch-create`, providing goal, measurement script, unit, direction (higher/lower), and verification command.

### Case Study: jsonista (Clojure JSON library)
Ran autoresearch on JSON decoding benchmarks. **Result: 56% ops/sec improvement** on one benchmark.

Changes found:
1. **PersistentArrayMap for small maps** — reasonable, similar approach used in Clojure core. Cherry-picked.
2. **String key specialization** — checked via class name string comparison. Suspicious but functional.
3. **Unrolled duplicate key checks for small maps** — switch/case with explicit pair comparisons for sizes 3-4. Improves benchmark but questionable generalizability.

### Honest Assessment
- Agent tries both good ideas and cargo-cult optimizations (e.g., replacing math with bitwise ops when compiler already does this)
- Results are mixed — some genuine improvements, some likely overfitting to the benchmark
- **Works better for constrained situations** (e.g., optimizing frontend bundle size) where there are fewer knobs and less to break

### Key Warning
> "I bet some people will see this and think that it will make their open source library blazing fast without having to understand anything. Those people will be playing stupid games to win stupid prizes."

Human judgement required: Do optimizations generalize? Is increased code complexity worth it?
