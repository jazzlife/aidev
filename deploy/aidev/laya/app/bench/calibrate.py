"""Per-kind temperature calibration of Laya (IMPLEMENTATION-PLAN E-07). Runs INSIDE the aidev-laya container:

  docker exec aidev-laya python /srv/app/current/control/laya/bench/calibrate.py [--out /models] [--write]

Asks Laya the gateway's own questions (agent hints, task kinds, remote actions — catalog.json / questions.json are
written by pack.sh from the gateway build) over the labelled sets (commands.jsonl, remote-actions.jsonl), then per
kind fits a temperature T (p_i ∝ p_i^(1/T)) by negative log-likelihood. Two-fold cross-validation says whether T
helps on commands it was not fitted on. With --write, kinds whose held-out NLL and ECE both improve are written to
<out>/calibration.json (temp file + rename: an atomic swap); the others keep T = 1.
"""
import argparse
import json
import math
import os
import random
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LAYA = os.environ.get("LAYA_URL", "http://127.0.0.1:8095")
GRID = [round(0.25 + 0.05 * i, 2) for i in range(76)]  # T in 0.25 .. 4.0
EPS = 1e-9


def post(path, body):
    req = urllib.request.Request(f"{LAYA}{path}", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def scaled(probs, t):
    """Temperature-scaled distribution: p_i^(1/t) renormalised."""
    logs = {k: math.log(max(v, EPS)) / t for k, v in probs.items()}
    m = max(logs.values())
    ex = {k: math.exp(v - m) for k, v in logs.items()}
    z = sum(ex.values())
    return {k: v / z for k, v in ex.items()}


def metrics(items, t):
    """NLL of the labels, ECE of the top choice and accuracy, for (probabilities, label) items at temperature t."""
    nll, pairs = 0.0, []
    for probs, label in items:
        p = scaled(probs, t)
        nll -= math.log(max(p.get(label, 0.0), EPS))
        top = max(p, key=p.get)
        pairs.append((p[top], top == label))
    n = len(items)
    ece = 0.0
    for b in range(10):
        lo, hi = b / 10, (b + 1) / 10
        chunk = [x for x in pairs if lo <= x[0] < hi or (b == 9 and x[0] == 1.0)]
        if chunk:
            ece += abs(sum(x[0] for x in chunk) / len(chunk) - sum(1 for x in chunk if x[1]) / len(chunk)) * len(chunk) / n
    return {"nll": round(nll / n, 4), "ece": round(ece, 4), "acc": round(sum(1 for x in pairs if x[1]) / n, 4)}


def fit(items):
    return min(GRID, key=lambda t: metrics(items, t)["nll"])


def calibrate_kind(items, seed=7):
    """T on all items, plus two-fold cross-validated before/after on held-out halves."""
    rows = list(items)
    random.Random(seed).shuffle(rows)
    half = len(rows) // 2
    folds = [(rows[:half], rows[half:]), (rows[half:], rows[:half])]
    held_before, held_after, ts = [], [], []
    for train, test in folds:
        t = fit(train)
        ts.append(t)
        held_before.append(metrics(test, 1.0))
        held_after.append(metrics(test, t))
    avg = lambda xs, k: round(sum(x[k] for x in xs) / len(xs), 4)  # noqa: E731
    t_all = fit(rows)
    cv = {"t_folds": ts, "before": {k: avg(held_before, k) for k in ("nll", "ece", "acc")}, "after": {k: avg(held_after, k) for k in ("nll", "ece", "acc")}}
    helps = cv["after"]["nll"] < cv["before"]["nll"] and cv["after"]["ece"] <= cv["before"]["ece"]
    return {"n": len(rows), "t": t_all, "all_before": metrics(rows, 1.0), "all_after": metrics(rows, t_all), "cv": cv, "helps": helps}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/models")
    ap.add_argument("--write", action="store_true", help="write calibration.json for the kinds that improve held-out")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    catalog = json.load(open(os.path.join(HERE, "catalog.json"), encoding="utf-8"))
    questions = json.load(open(os.path.join(HERE, "questions.json"), encoding="utf-8"))
    commands = [json.loads(l) for l in open(os.path.join(HERE, "commands.jsonl"), encoding="utf-8") if l.strip()]
    remote = [json.loads(l) for l in open(os.path.join(HERE, "remote-actions.jsonl"), encoding="utf-8") if l.strip()]
    if args.limit:
        commands, remote = commands[: args.limit], remote[: args.limit]
    hints = {k: v["hint"] or v["description"] for k, v in catalog.items()}
    health = json.loads(urllib.request.urlopen(f"{LAYA}/health", timeout=10).read())
    items = {"route.agent": [], "route.task_kind": [], "route.remote_action": []}
    t0 = time.time()
    for i, row in enumerate(commands):
        q = {"agent": {"type": "choice", "instructions": questions["agent_instructions"], "criteria": hints},
             "task_kind": {"type": "choice", "instructions": questions["task_kind_instructions"], "criteria": questions["task_kind"]}}
        a = post("/decide", {"state": {"command": row["text"]}, "questions": q})["answers"]
        if row.get("agent") in hints:
            items["route.agent"].append((a["agent"]["probabilities"], row["agent"]))
        if row.get("task_kind") in questions["task_kind"]:
            items["route.task_kind"].append((a["task_kind"]["probabilities"], row["task_kind"]))
        print(f"[commands {i + 1}/{len(commands)}]", file=sys.stderr, end="\r")
    for i, row in enumerate(remote):
        q = {"remote_action": {"type": "choice", "instructions": questions["remote_action_instructions"], "criteria": questions["remote_action"]}}
        a = post("/decide", {"state": {"command": row["text"]}, "questions": q})["answers"]
        if row.get("remote_action") in questions["remote_action"]:
            items["route.remote_action"].append((a["remote_action"]["probabilities"], row["remote_action"]))
        print(f"[remote {i + 1}/{len(remote)}]", file=sys.stderr, end="\r")
    kinds = {kind: calibrate_kind(rows) for kind, rows in items.items() if len(rows) >= 20}
    result = {"release": health.get("release"), "model": health.get("model"), "device": health.get("device"),
              "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seconds": round(time.time() - t0, 1), "kinds": kinds}
    print(json.dumps(result, ensure_ascii=False, indent=1))
    if args.write:
        params = {k: {"t": v["t"], "n": v["n"], "cv_before": v["cv"]["before"], "cv_after": v["cv"]["after"]} for k, v in kinds.items() if v["helps"]}
        out = os.path.join(args.out, "calibration.json")
        tmp = f"{out}.{os.getpid()}.tmp"
        json.dump({"release": result["release"], "date": result["date"], "kinds": params}, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        os.replace(tmp, out)
        print(f"wrote {out}: {list(params) or 'no kind improved — all stay at T = 1'}", file=sys.stderr)


if __name__ == "__main__":
    main()
