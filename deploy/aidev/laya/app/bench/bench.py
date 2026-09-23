"""Laya routing benchmark (IMPLEMENTATION-PLAN §3.9). Runs INSIDE the aidev-laya container:

  docker exec aidev-laya python /srv/app/current/control/laya/bench/bench.py [--limit N] [--out DIR]

Asks Laya the same questions the gateway asks at send time (agent / depth / task_kind / risk),
with the seed catalog from catalog.json, and reports accuracy, depth MAE, ECE and latency.
Results are written to /models/bench/<date>-<release>.json (models volume) and printed.
"""
import argparse
import json
import os
import statistics
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LAYA = os.environ.get("LAYA_URL", "http://127.0.0.1:8095")
DEPTH = ["instant answer, lookup or a one-line change", "local change inside one file", "a feature touching several files",
         "debugging an unknown cause, refactoring or design work", "architecture, migration or long-running multi-step work"]
RISK = ["read-only or trivial", "modifies files or configuration", "destructive or hard to undo"]
TASK_KIND = {
    "bulk_read": "reading, scanning, summarizing or analyzing a large amount of data, files, logs or documents",
    "implement": "writing new code or features", "debug": "finding and fixing a bug or failure",
    "refactor": "restructuring existing code without changing behavior", "design": "architecture, planning, API or schema design",
    "ops": "deployment, infrastructure, servers, containers, CI, environment setup", "explain": "explaining, answering a question, documentation",
}


def post(path, body):
    req = urllib.request.Request(f"{LAYA}{path}", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def top(answer):
    probs = answer.get("probabilities") or {}
    if not probs:
        return answer.get("choice"), 0.0
    k = max(probs, key=probs.get)
    return k, probs[k]


def ece(pairs, bins=10):
    """Expected calibration error over (confidence, correct) pairs."""
    if not pairs:
        return None
    total = len(pairs)
    err = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        chunk = [p for p in pairs if lo <= p[0] < hi or (b == bins - 1 and p[0] == 1.0)]
        if not chunk:
            continue
        conf = sum(p[0] for p in chunk) / len(chunk)
        acc = sum(1 for p in chunk if p[1]) / len(chunk)
        err += abs(conf - acc) * len(chunk) / total
    return round(err, 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="/models/bench")
    ap.add_argument("--commands", default=os.path.join(HERE, "commands.jsonl"))
    ap.add_argument("--catalog", default=os.path.join(HERE, "catalog.json"))
    args = ap.parse_args()
    catalog = json.load(open(args.catalog, encoding="utf-8"))
    rows = [json.loads(l) for l in open(args.commands, encoding="utf-8") if l.strip()]
    if args.limit:
        rows = rows[: args.limit]
    health = json.loads(urllib.request.urlopen(f"{LAYA}/health", timeout=10).read())
    questions = {
        "agent": {"type": "choice", "instructions": "Which specialist agent should handle this developer command? Pick the agent whose expertise matches the task best.", "criteria": catalog},
        "depth": {"type": "score", "instructions": "How deep is this task?", "criteria": DEPTH},
        "task_kind": {"type": "choice", "instructions": "What kind of work is this command mainly asking for?", "criteria": TASK_KIND},
        "risk": {"type": "score", "instructions": "How risky is executing this command on a developer workstation?", "criteria": RISK},
    }
    results, lat = [], []
    for i, r in enumerate(rows):
        t0 = time.time()
        res = post("/decide", {"state": {"command": r["text"]}, "questions": questions})
        lat.append((time.time() - t0) * 1000)
        a = res["answers"]
        agent, p_agent = top(a["agent"])
        kind, p_kind = top(a["task_kind"])
        depth = a["depth"].get("score", 0)
        results.append({**r, "pred_agent": agent, "p_agent": round(p_agent, 4), "pred_depth": depth, "pred_kind": kind, "p_kind": round(p_kind, 4),
                        "risk": a["risk"].get("score"), "ms": round(lat[-1], 1)})
        print(f"[{i+1}/{len(rows)}] {'OK ' if agent == r['agent'] else 'MISS'} agent={agent}({p_agent:.2f}) want={r['agent']} depth={depth}/{r['depth']} kind={kind}/{r['task_kind']} {lat[-1]:.0f}ms", file=sys.stderr)
    n = len(results)
    agent_acc = sum(1 for x in results if x["pred_agent"] == x["agent"]) / n
    kind_acc = sum(1 for x in results if x["pred_kind"] == x["task_kind"]) / n
    depth_mae = sum(abs(x["pred_depth"] - x["depth"]) for x in results) / n
    by_lang = {}
    for lang in ("ko", "en"):
        sub = [x for x in results if x["lang"] == lang]
        if sub:
            by_lang[lang] = {"n": len(sub), "agent_acc": round(sum(1 for x in sub if x["pred_agent"] == x["agent"]) / len(sub), 4)}
    confusion = {}
    for x in results:
        if x["pred_agent"] != x["agent"]:
            confusion.setdefault(x["agent"], {}).setdefault(x["pred_agent"], 0)
            confusion[x["agent"]][x["pred_agent"]] += 1
    lat_sorted = sorted(lat)
    summary = {
        "release": health.get("release"), "model": health.get("model"), "device": health.get("device"), "laya": health.get("laya"), "torch": health.get("torch"),
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "n": n, "catalog_size": len(catalog),
        "agent_accuracy": round(agent_acc, 4), "task_kind_accuracy": round(kind_acc, 4), "depth_mae": round(depth_mae, 4),
        "agent_ece": ece([(x["p_agent"], x["pred_agent"] == x["agent"]) for x in results]),
        "by_lang": by_lang, "confusion": confusion,
        "latency_ms": {"p50": round(statistics.median(lat_sorted), 1), "p95": round(lat_sorted[int(len(lat_sorted) * 0.95) - 1], 1), "mean": round(statistics.mean(lat), 1)},
        "pass": {"agent_accuracy>=0.75": agent_acc >= 0.75, "depth_mae<=0.8": depth_mae <= 0.8},
    }
    os.makedirs(args.out, exist_ok=True)
    out = os.path.join(args.out, f"{time.strftime('%Y%m%d-%H%M%S')}-{health.get('release', 'unknown')}.json")
    json.dump({"summary": summary, "results": results}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"saved {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
