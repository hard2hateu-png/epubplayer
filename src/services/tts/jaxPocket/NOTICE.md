# JAX-JS Pocket experiment

`model.ts` in this directory is vendored from the Pocket TTS browser demo in
[`ekzhang/jax-js`](https://github.com/ekzhang/jax-js), pinned to commit
`ef32174b3b64e44422f148078ac0cacdf50384aa` for this experiment.

The upstream project is MIT licensed. This experiment adapts its Pocket model
implementation to the EPUB reader's existing TTS service contract. Leo audio
and Leo's generated voice embedding remain local to the browser and are never
committed to this repository.
