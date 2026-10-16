# handwired runtime (vendored)

`numeric-ui-core.ts` is copied unchanged from [chenglou/handwired](https://github.com/chenglou/handwired) at commit `4ea7fcb`
(`src/runtime/numeric-ui-core.ts`), MIT License, Copyright (c) 2026 Cheng Lou (see `LICENSE`).

Funnier's humour engine (`src/engine.js`) builds its feature program and taste model as one handwired `Circuit`
(affine sums + ReGLU products, `circuit.select` for if/else), evaluates it with `evaluateReference` and trains it with
`backpropagateReference`. esbuild strips the types when bundling; Node >= 22.18 imports the `.ts` file directly.
Bundled cost: ~23 KB minified (~8 KB gzip). To update, copy the file again and run `node tools/test-humour-engine.mjs`.
