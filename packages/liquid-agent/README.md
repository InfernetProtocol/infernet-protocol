# @infernetprotocol/liquid-agent

The liquid-agent/v1 contract and the client for `infernet-liquid`, the isolated Python runtime behind Infernet's temporal-policy family (CfC and LTC liquid neural networks from [ncps](https://github.com/mlech26l/ncps), with a GRU baseline).

```js
import { buildBundle, verifyBundle, validate, LiquidRuntime } from "@infernetprotocol/liquid-agent";

const bundle = buildBundle(reviewedEpisodes, { consent, strategy: "by_session", seed: 0 });
verifyBundle(bundle); // schema + hashes + secret scan
const rt = new LiquidRuntime(); // needs `infernet model runtime setup --yes`
const res = await rt.request("train", { bundle_path, output_dir, family: "cfc" });
```

Design, protocol, error codes and threat model: [docs/liquid-agent](../../docs/liquid-agent/README.md).

Runtime dev loop (from `runtime/`): `PYTHONPATH=. python -m unittest tests.test_runtime`, `python -m tests.make_fixtures`, `python -m infernet_liquid bench --out-dir /some/dir`.
