"""python -m infernet_liquid <serve|train|evaluate|synth|bench|health>"""

import argparse
import json
import sys

from .errors import LiquidError


def main(argv=None):
    ap = argparse.ArgumentParser(prog="infernet-liquid")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="stdio NDJSON server (the Infernet contract)")
    s.add_argument("--max-sessions", type=int, default=64)
    s.add_argument("--ttl", type=int, default=600)
    s.add_argument("--worker", default="local")
    t = sub.add_parser("train")
    t.add_argument("--dataset", required=True)
    t.add_argument("--family", default="cfc", choices=["cfc", "ltc", "gru"])
    t.add_argument("--output", required=True)
    t.add_argument("--epochs", type=int)
    t.add_argument("--seed", type=int)
    t.add_argument("--hidden", type=int)
    t.add_argument("--threads", type=int)
    e = sub.add_parser("evaluate")
    e.add_argument("--model", required=True)
    e.add_argument("--dataset", required=True)
    e.add_argument("--split", default="test")
    y = sub.add_parser("synth")
    y.add_argument("--out", required=True)
    y.add_argument("--per-task", type=int, default=160)
    y.add_argument("--seed", type=int, default=7)
    y.add_argument("--shifted", action="store_true")
    b = sub.add_parser("bench")
    b.add_argument("--out-dir", required=True)
    b.add_argument("--per-task", type=int, default=160)
    b.add_argument("--families", default="cfc,gru,ltc")
    b.add_argument("--seeds", default="0,1,2")
    b.add_argument("--epochs", type=int)
    b.add_argument("--threads", type=int, default=4)
    b.add_argument("--report")
    sub.add_parser("health")
    a = ap.parse_args(argv)

    try:
        if a.cmd == "serve":
            from .server import Server

            Server(max_sessions=a.max_sessions, ttl_s=a.ttl, worker=a.worker).serve()
            return 0
        if a.cmd == "health":
            from .server import Server

            print(json.dumps(Server().dispatch("health", {}), indent=2))
            return 0
        if a.cmd == "train":
            from .server import run_train

            hp = {k: v for k, v in {"epochs": a.epochs, "seed": a.seed, "hidden_units": a.hidden}.items() if v is not None}
            res = run_train({"bundle_path": a.dataset, "family": a.family, "output_dir": a.output, "hyperparameters": hp, "max_threads": a.threads},
                            on_event=lambda ev: print(json.dumps(ev), file=sys.stderr))
            print(json.dumps({"model_dir": res["model_dir"], "model_hash": res["manifest"]["weights"]["weights_hash"], "metrics": res["eval"]["metrics"]}, indent=2))
            return 0
        if a.cmd == "evaluate":
            from .server import run_evaluate

            print(json.dumps(run_evaluate({"model_dir": a.model, "bundle_path": a.dataset, "split": a.split}), indent=2))
            return 0
        if a.cmd == "synth":
            from .synth import make_bundle

            bundle = make_bundle(per_task=a.per_task, seed=a.seed, shifted=a.shifted)
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump(bundle, f, separators=(",", ":"))
            print(json.dumps({"out": a.out, "dataset_hash": bundle["manifest"]["dataset_hash"], "counts": bundle["manifest"]["splits"]["counts"]}))
            return 0
        if a.cmd == "bench":
            from .bench import render_markdown, run

            s = run(a.out_dir, a.per_task, tuple(a.families.split(",")), tuple(int(x) for x in a.seeds.split(",")), a.epochs,
                    on_event=lambda ev: print(json.dumps(ev), file=sys.stderr), threads=a.threads)
            md = render_markdown(s)
            if a.report:
                with open(a.report, "w", encoding="utf-8") as f:
                    f.write(md)
            print(md)
            return 0
    except LiquidError as err:
        print(json.dumps({"error": err.to_json()}), file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
