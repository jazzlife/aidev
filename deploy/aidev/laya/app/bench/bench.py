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


# ---- routing strategies under test (--experiments) ------------------------------------------
TASK_KIND_SHORT = {
    "bulk_read": "read or analyze many files or long logs", "implement": "write new code or a feature", "debug": "find and fix a bug",
    "refactor": "restructure code, same behavior", "design": "plan architecture, API or schema", "ops": "deploy, servers, containers, CI", "explain": "explain, answer, document",
}
DEPTH_SHORT = ["one-line answer or trivial change", "small change in one file", "feature across several files", "unknown-cause debugging, refactor or design", "architecture or migration, many steps"]
DOMAINS = {  # coarse stage for the two-stage strategy; members are seed agent names
    "web-ui": (["frontend-react", "mobile-responsive"], "web frontend UI React mobile"),
    "server": (["backend-node", "database"], "backend API server database SQL"),
    "infra": (["devops", "git-workflow", "security-review"], "deploy Docker servers git security"),
    "device": (["tizen-device", "android-device"], "Samsung Tizen Android device apps"),
    "quality": (["testing", "docs"], "tests documentation"),
    "ai": (["ai-integration"], "LLM agents MCP prompts"),
    "general": (["generalist"], "general small tasks questions"),
}


def strategies(catalog, health):
    """Each strategy: name -> function(text) -> (agent, p_agent, depth, kind, p_kind, risk, calls)."""
    hints = {k: v["hint"] for k, v in catalog.items()}
    longs = {k: v["description"] for k, v in catalog.items()}
    base_tail = lambda tk, dp: {  # noqa: E731
        "depth": {"type": "score", "instructions": "How deep is the work in `command`?", "criteria": dp},
        "task_kind": {"type": "choice", "instructions": "What kind of work does `command` mainly ask for?", "criteria": tk},
        "risk": {"type": "score", "instructions": "How risky is executing `command` on a developer workstation?", "criteria": RISK},
    }

    def flat(criteria, instructions, tk=TASK_KIND, dp=DEPTH):
        def run(text):
            q = {"agent": {"type": "choice", "instructions": instructions, "criteria": criteria}, **base_tail(tk, dp)}
            a = post("/decide", {"state": {"command": text}, "questions": q})["answers"]
            agent, p = top(a["agent"]); kind, pk = top(a["task_kind"])
            return agent, p, a["depth"].get("score", 0), kind, pk, a["risk"].get("score"), 1
        return run

    def two_stage(tk=TASK_KIND_SHORT, dp=DEPTH_SHORT):
        dom_crit = {d: v[1] for d, v in DOMAINS.items()}
        def run(text):
            q = {"domain": {"type": "choice", "instructions": "Which area does the developer request in `command` belong to?", "criteria": dom_crit}, **base_tail(tk, dp)}
            a = post("/decide", {"state": {"command": text}, "questions": q})["answers"]
            dom, pd = top(a["domain"]); kind, pk = top(a["task_kind"])
            members = [m for m in DOMAINS[dom][0] if m in hints]
            calls = 1
            if len(members) == 1:
                agent, p = members[0], pd
            else:
                q2 = {"agent": {"type": "choice", "instructions": "Which specialist should handle the developer request in `command`?", "criteria": {m: hints[m] for m in members}}}
                a2 = post("/decide", {"state": {"command": text}, "questions": q2})["answers"]
                agent, p2 = top(a2["agent"]); p = pd * p2; calls = 2
            return agent, p, a["depth"].get("score", 0), kind, pk, a["risk"].get("score"), calls
        return run

    def ensemble(alpha=0.5, tau=0.05):
        """Average Laya choice probabilities with a cosine-similarity softmax over "name: hint" embeddings."""
        names = list(hints)
        opt_vecs = post("/embed", {"texts": [f"{n}: {hints[n]}" for n in names]})["vectors"]
        import math
        def norm(v):
            s = math.sqrt(sum(x * x for x in v)) or 1.0
            return [x / s for x in v]
        opt_vecs = [norm(v) for v in opt_vecs]
        inner = flat(hints, "Which specialist should handle the developer request in `command`?", TASK_KIND_SHORT, DEPTH_SHORT)
        def run(text):
            q = {"agent": {"type": "choice", "instructions": "Which specialist should handle the developer request in `command`?", "criteria": hints}, **base_tail(TASK_KIND_SHORT, DEPTH_SHORT)}
            a = post("/decide", {"state": {"command": text}, "questions": q})["answers"]
            probs = a["agent"]["probabilities"]
            cv = norm(post("/embed", {"texts": [text]})["vectors"][0])
            sims = [sum(x * y for x, y in zip(cv, ov)) for ov in opt_vecs]
            mx = max(sims); ex = [math.exp((s_ - mx) / tau) for s_ in sims]; z = sum(ex)
            emb = {n: e / z for n, e in zip(names, ex)}
            mixed = {n: alpha * probs.get(n, 0) + (1 - alpha) * emb[n] for n in names}
            agent = max(mixed, key=mixed.get)
            kind, pk = top(a["task_kind"])
            return agent, mixed[agent], a["depth"].get("score", 0), kind, pk, a["risk"].get("score"), 2
        _ = inner
        return run

    return {
        "A_long_desc": flat(longs, "Which specialist agent should handle this developer command? Pick the agent whose expertise matches the task best."),
        "B_short_hint": flat(hints, "Which specialist should handle the developer request in `command`?"),
        "C_hint_shortcrit": flat(hints, "Which specialist should handle the developer request in `command`?", TASK_KIND_SHORT, DEPTH_SHORT),
        "D_two_stage": two_stage(),
        "E_embed_ensemble": ensemble(),
    }


def score_rows(rows, run):
    results, lat = [], []
    for i, r in enumerate(rows):
        t0 = time.time()
        agent, p_agent, depth, kind, p_kind, risk, calls = run(r["text"])
        lat.append((time.time() - t0) * 1000)
        results.append({**r, "pred_agent": agent, "p_agent": round(p_agent, 4), "pred_depth": depth, "pred_kind": kind, "p_kind": round(p_kind, 4), "risk": risk, "ms": round(lat[-1], 1), "calls": calls})
        print(f"[{i+1}/{len(rows)}] {'OK ' if agent == r['agent'] else 'MISS'} agent={agent}({p_agent:.2f}) want={r['agent']} depth={depth}/{r['depth']} kind={kind}/{r['task_kind']} {lat[-1]:.0f}ms", file=sys.stderr)
    return results, lat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="/models/bench")
    ap.add_argument("--commands", default=os.path.join(HERE, "commands.jsonl"))
    ap.add_argument("--catalog", default=os.path.join(HERE, "catalog.json"))
    ap.add_argument("--experiments", action="store_true", help="specialist-decision experiments S1..S7 (use / generalist / create) — see specialist.py")
    ap.add_argument("--routing-experiments", action="store_true", help="older relative-choice strategies A..E")
    ap.add_argument("--strategy", default="B_short_hint", help="strategy used for the single run (default: what the gateway does)")
    args = ap.parse_args()
    catalog = json.load(open(args.catalog, encoding="utf-8"))
    rows = [json.loads(l) for l in open(args.commands, encoding="utf-8") if l.strip()]
    if args.limit:
        rows = rows[: args.limit]
    health = json.loads(urllib.request.urlopen(f"{LAYA}/health", timeout=10).read())
    if args.experiments:
        import specialist
        table, misses = specialist.run_all(catalog, args.commands, args.limit)
        print(json.dumps({"release": health.get("release"), "device": health.get("device"), "head_max_len": health.get("head_max_len"), "max_len": health.get("max_len"), "specialist_experiments": table, "misses": misses}, ensure_ascii=False, indent=1))
        os.makedirs(args.out, exist_ok=True)
        json.dump({"table": table, "misses": misses}, open(os.path.join(args.out, f"specialist-{time.strftime('%Y%m%d-%H%M%S')}.json"), "w"), ensure_ascii=False, indent=1)
        return
    strat = strategies(catalog, health)
    if args.routing_experiments:
        table = []
        for name, run in strat.items():
            print(f"=== {name}", file=sys.stderr)
            try:
                res, lat = score_rows(rows, run)
            except Exception as e:  # noqa: BLE001
                print(f"{name}: failed {e}", file=sys.stderr); continue
            n = len(res)
            table.append({"strategy": name, "agent_acc": round(sum(1 for x in res if x["pred_agent"] == x["agent"]) / n, 3),
                          "ko": round(sum(1 for x in res if x["lang"] == "ko" and x["pred_agent"] == x["agent"]) / max(1, sum(1 for x in res if x["lang"] == "ko")), 3),
                          "en": round(sum(1 for x in res if x["lang"] == "en" and x["pred_agent"] == x["agent"]) / max(1, sum(1 for x in res if x["lang"] == "en")), 3),
                          "kind_acc": round(sum(1 for x in res if x["pred_kind"] == x["task_kind"]) / n, 3), "depth_mae": round(sum(abs(x["pred_depth"] - x["depth"]) for x in res) / n, 3),
                          "ece": ece([(x["p_agent"], x["pred_agent"] == x["agent"]) for x in res]), "p50_ms": round(statistics.median(lat), 0)})
            print(json.dumps(table[-1]), file=sys.stderr)
        print(json.dumps({"release": health.get("release"), "device": health.get("device"), "head_max_len": health.get("head_max_len"), "max_len": health.get("max_len"), "experiments": table}, indent=1))
        os.makedirs(args.out, exist_ok=True)
        json.dump(table, open(os.path.join(args.out, f"experiments-{time.strftime('%Y%m%d-%H%M%S')}.json"), "w"), indent=1)
        return
    results, lat = score_rows(rows, strat[args.strategy])
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
