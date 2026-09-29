"""Specialist-decision experiments (IMPLEMENTATION-PLAN §3.1, R-LAYA): can Laya make the absolute call the
LLM judge makes today — use an existing specialist / generalist / create a new one — and which way of
handing it tokens works best? Runs INSIDE the aidev-laya container (bench.py --experiments).

Token budget facts this suite probes: the state (command + extra fields) has max_len ≈1024 tokens, every
question's instructions + options share head_max_len ≈256. A 12-way choice with long descriptions is
truncated; a per-candidate question or a descriptor moved into the state gets a full budget.

Strategies (decision → agent name | "generalist" | None = create):
  S1_choice_hint     one choice: short hints + "none of these" + "trivial"                      (1 call)
  S2_choice_en       same with the English part of each description                              (1 call)
  S3_noul_each       one yes/no per candidate "<name>: <english description>" + trivial, one call  (1 call, 13 q)
  S4_state_desc_top3 top-3 by embedding; the candidate's full description goes into the STATE,
                     the question stays short                                                    (3 calls)
  S5_tech_focus      S3 with `technologies` (tech words pulled out of the command) added to the state
  S6_embed_novelty   cosine(command, "<name>: <description>") → best agent, create below a threshold (0 predict)
  S7_pair_choice     top-3 by embedding; per candidate a 3-way choice in the state-desc form:
                     "specialist" / "related but not a specialist" / "unrelated"                (3 calls)
Each prints {"strategy": …} lines (verify-b.sh collects those) with accuracy on use / generalist / create.
"""
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LAYA = os.environ.get("LAYA_URL", "http://127.0.0.1:8095")
HANGUL = re.compile(r"[가-힣]")
TRIVIAL_Q = "Is `command` trivial or domain-less (a quick question, running a ready-made shell command the user spelled out, a tiny rename or typo fix) so that no specialist is needed?"


def post(path, body):
    req = urllib.request.Request(f"{LAYA}{path}", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def english(desc):
    m = HANGUL.search(desc)
    return (desc[: m.start()] if m else desc).strip()


# technology words: latin tokens (React, URP, sdb, ERC-20) and a few Korean spellings of common ones
KO_TECH = {"리액트": "React", "셰이더": "shader", "쿠버네티스": "Kubernetes", "도커": "Docker", "안드로이드": "Android", "타이젠": "Tizen",
           "코틀린": "Kotlin", "파이썬": "Python", "러스트": "Rust", "깃": "git", "데이터베이스": "database", "테스트": "tests", "문서": "docs",
           "퀀트": "quant trading", "백테스트": "backtest", "펌웨어": "firmware", "보안": "security", "인젝션": "injection", "리베이스": "rebase"}


def technologies(text):
    words = re.findall(r"[A-Za-z][A-Za-z0-9.+#_-]*", text)
    words += [v for k, v in KO_TECH.items() if k in text]
    seen, out = set(), []
    for w in words:
        if w.lower() not in seen:
            seen.add(w.lower()); out.append(w)
    return ", ".join(out) or "(none named)"


def norm(v):
    s = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / s for x in v]


def top(answer):
    probs = answer.get("probabilities") or {}
    if not probs:
        return answer.get("choice"), 0.0
    k = max(probs, key=probs.get)
    return k, probs[k]


def load_rows(path_bench, path_specialist):
    rows = []
    for line in open(path_specialist, encoding="utf-8"):
        if line.strip():
            r = json.loads(line); rows.append({"text": r["text"], "accept": r["accept"], "set": "specialist"})
    for line in open(path_bench, encoding="utf-8"):
        if line.strip():
            r = json.loads(line); rows.append({"text": r["text"], "accept": [r["agent"]], "set": "routing"})
    return rows


def suite(catalog):
    specs = {k: v for k, v in catalog.items() if k != "generalist"}
    names = list(specs)
    hints = {k: v["hint"] for k, v in specs.items()}
    en = {k: english(v["description"]) for k, v in specs.items()}
    full = {k: v["description"] for k, v in specs.items()}
    vecs = dict(zip(names, (norm(v) for v in post("/embed", {"texts": [f"{n}: {full[n]}" for n in names]})["vectors"])))
    usage = {}

    def emb_rank(text):
        cv = norm(post("/embed", {"texts": [text]})["vectors"][0])
        return sorted(((sum(a * b for a, b in zip(cv, vecs[n])), n) for n in names), reverse=True)

    def predict(state, questions, tag):
        r = post("/decide", {"state": state, "questions": questions})
        if tag not in usage and r.get("usage"):
            usage[tag] = r["usage"]
        return r["answers"]

    def choice(descs, tag):
        crit = dict(descs)
        crit["none"] = "none of these: the command needs a technology or domain no listed agent declares"
        crit["trivial"] = "trivial or domain-less request: quick question, ready-made shell command, tiny rename"
        def run(text):
            a = predict({"command": text}, {"agent": {"type": "choice", "instructions": "Which listed agent is a TRUE specialist for `command` (its declared domain explicitly covers the main technology)?", "criteria": crit}}, tag)
            pick, p = top(a["agent"])
            return (None if pick == "none" else "generalist" if pick == "trivial" else pick), p, 1, None
        return run

    def noul_each(extra_state, tag, tau):
        def run(text):
            state = {"command": text, **extra_state(text)}
            q = {n: {"type": "noul", "instructions": f"Is the agent \"{n}\" ({en[n]}) a TRUE specialist whose declared domain explicitly covers the main technology of `command`? A shared generic skill is not enough."} for n in names}
            q["_trivial"] = {"type": "noul", "instructions": TRIVIAL_Q}
            a = predict(state, q, tag)
            yes = {n: a[n]["noul"] for n in names}
            best = max(yes, key=yes.get)
            meta = {"best": best, "score": yes[best], "triv": a["_trivial"]["noul"]}
            if yes[best] >= tau:
                return best, yes[best], 1, meta
            return ("generalist" if a["_trivial"]["noul"] >= 0.5 else None), 1 - yes[best], 1, meta
        return run

    def state_desc(tag, tau, k=3):
        def run(text):
            ranked = emb_rank(text)[:k]
            best, bp, triv = None, 0.0, None
            for _, n in ranked:
                q = {"fit": {"type": "noul", "instructions": "Is the agent described in `agent` a TRUE specialist for `command` — does its declared domain explicitly cover the command's main technology? A shared generic skill is not enough."}}
                if triv is None:
                    q["_trivial"] = {"type": "noul", "instructions": TRIVIAL_Q}
                a = predict({"command": text, "agent": f"{n}: {full[n]}"}, q, tag)
                if "_trivial" in a:
                    triv = a["_trivial"]["noul"]
                if a["fit"]["noul"] > bp:
                    best, bp = n, a["fit"]["noul"]
            meta = {"best": best, "score": bp, "triv": triv or 0}
            if bp >= tau:
                return best, bp, k, meta
            return ("generalist" if (triv or 0) >= 0.5 else None), 1 - bp, k, meta
        return run

    def pair_choice(tag, k=3):
        crit = {"specialist": "the agent's declared domain explicitly covers the command's main technology",
                "related": "related area or a shared generic skill, but not a specialist in that technology",
                "unrelated": "a different domain"}
        def run(text):
            ranked = emb_rank(text)[:k]
            best, bp, triv = None, 0.0, None
            for _, n in ranked:
                q = {"fit": {"type": "choice", "instructions": "How well does the agent described in `agent` match `command`?", "criteria": crit}}
                if triv is None:
                    q["_trivial"] = {"type": "noul", "instructions": TRIVIAL_Q}
                a = predict({"command": text, "agent": f"{n}: {full[n]}"}, q, tag)
                if "_trivial" in a:
                    triv = a["_trivial"]["noul"]
                p = (a["fit"].get("probabilities") or {}).get("specialist", 0.0)
                if p > bp:
                    best, bp = n, p
            meta = {"best": best, "score": bp, "triv": triv or 0}
            if bp >= 0.5:
                return best, bp, k, meta
            return ("generalist" if (triv or 0) >= 0.5 else None), 1 - bp, k, meta
        return run

    def embed_novelty(tau):
        def run(text):
            s, n = emb_rank(text)[0]
            return (n if s >= tau else None), s, 0, {"best": n, "score": s, "triv": 0.0}
        return run

    runs = {
        "S1_choice_hint": choice(hints, "S1"),
        "S2_choice_en": choice(en, "S2"),
        "S3_noul_each": noul_each(lambda t: {}, "S3", 0.5),
        "S4_state_desc_top3": state_desc("S4", 0.5),
        "S5_tech_focus": noul_each(lambda t: {"technologies": technologies(t)}, "S5", 0.5),
        "S6_embed_novelty": embed_novelty(0.5),
        "S7_pair_choice": pair_choice("S7"),
    }
    return runs, usage


def score(rows, run):
    out, lat = [], []
    for r in rows:
        t0 = time.time()
        pred, p, calls, meta = run(r["text"])
        lat.append((time.time() - t0) * 1000)
        out.append({**r, "pred": pred, "p": round(float(p), 4), "calls": calls, "ok": pred in r["accept"], "meta": meta})
    return out, lat


def summarize(name, res, lat, usage):
    def acc(sub):
        return round(sum(1 for x in sub if x["ok"]) / len(sub), 3) if sub else None
    use = [x for x in res if any(a not in (None, "generalist") for a in x["accept"])]
    gen = [x for x in res if x["accept"] == ["generalist"]]
    new = [x for x in res if x["accept"] == [None] or (None in x["accept"] and len(x["accept"]) == 1)]
    wrong_use = sum(1 for x in res if x["pred"] not in (None, "generalist") and not x["ok"])
    sweep = None
    if all(x["meta"] for x in res):
        # the same raw scores under other thresholds: which cut-off would have been best?
        grid = {}
        for tau in [i / 20 for i in range(2, 20)]:
            ok = 0
            for x in res:
                m = x["meta"]
                pred = m["best"] if m["score"] >= tau else ("generalist" if m["triv"] >= 0.5 else None)
                ok += pred in x["accept"]
            grid[tau] = round(ok / len(res), 3)
        bt = max(grid, key=grid.get)
        sweep = {"best_tau": bt, "best_acc": grid[bt], "at": {k: grid[k] for k in (0.3, 0.5, 0.7, 0.9) if k in grid}}
    return {"strategy": name, "acc": acc(res), "sweep": sweep, "acc_specialist_set": acc([x for x in res if x["set"] == "specialist"]), "acc_routing_set": acc([x for x in res if x["set"] == "routing"]),
            "use": acc(use), "generalist": acc(gen), "create": acc(new), "wrong_agent_used": wrong_use,
            "p50_ms": round(statistics.median(lat), 0), "p95_ms": round(sorted(lat)[int(len(lat) * 0.95) - 1], 0), "usage": usage.get(name.split("_")[0])}


def run_all(catalog, bench_path, limit=0):
    rows = load_rows(bench_path, os.path.join(HERE, "specialist.jsonl"))
    if limit:
        rows = rows[:limit]
    runs, usage = suite(catalog)
    table, misses = [], {}
    for name, run in runs.items():
        print(f"=== {name}", file=sys.stderr)
        try:
            res, lat = score(rows, run)
        except Exception as e:  # noqa: BLE001
            print(f"{name}: failed {type(e).__name__}: {e}", file=sys.stderr); continue
        table.append(summarize(name, res, lat, usage))
        misses[name] = [f"{x['text'][:30]} → {x['pred']} (want {x['accept']})" for x in res if not x["ok"] and x["set"] == "specialist"][:12]
        print(json.dumps(table[-1], ensure_ascii=False), file=sys.stderr)
        print(json.dumps({"strategy_misses": name, "misses": misses[name]}, ensure_ascii=False), file=sys.stderr)
    return table, misses
