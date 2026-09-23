"""aidev Laya decision service.

Thin HTTP wrapper around the Laya System-1 decision model (typed decisions with calibrated
probabilities). Lives in the release volume; the image only provides torch/laya.

  GET  /health            {status, loaded, device, model, release}
  POST /route             {text, agents:{id:description}, instructions?, threshold?, extra?}
                          -> {agent, confidence, probabilities, needs_new, alternatives, latency_ms}
  POST /decide            {state, questions}  raw laya predict (choice/score/noul) + latency_ms, device
  POST /shortlist         {state, options:{id:desc}, k, instructions?} -> {keep:[id]}  embedding shortlist

Only reachable on aidev-control-net; the gateway is the sole caller.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("LAYA_MODEL", "convaiinnovations/laya-multilingual")
DEVICE = os.environ.get("LAYA_DEVICE", "auto")  # auto | cuda | cpu   (ROCm shows up as "cuda")
PORT = int(os.environ.get("PORT", "8095"))
SHORTLIST_K = int(os.environ.get("LAYA_SHORTLIST_K", "20"))
RELEASE = "unknown"
try:
    RELEASE = open(os.path.join(os.path.dirname(__file__), "..", "..", "RELEASE")).read().strip()
except OSError:
    pass

STATE = {"loaded": False, "error": None, "device": None, "agent": None, "gpu": None}
LOCK = threading.Lock()


def resolve_device():
    import torch
    if DEVICE != "auto":
        return DEVICE
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_model():
    try:
        import torch
        import laya
        dev = resolve_device()
        gpu = None
        if dev == "cuda":
            try:
                gpu = torch.cuda.get_device_name(0)
            except Exception as e:  # noqa: BLE001
                gpu = f"unknown ({e})"
        t0 = time.time()
        agent = laya.load(MODEL, device=dev)
        # warm-up: first forward pass compiles kernels / allocates
        agent.predict("warm up", {"q": {"type": "noul", "instructions": "Is this a warm-up?"}})
        with LOCK:
            STATE.update(loaded=True, device=str(agent.device), agent=agent, gpu=gpu,
                         load_seconds=round(time.time() - t0, 1), laya=laya.__version__, torch=torch.__version__)
        print(f"[laya] loaded {MODEL} on {agent.device} ({gpu}) in {STATE['load_seconds']}s", flush=True)
    except Exception as e:  # noqa: BLE001
        with LOCK:
            STATE.update(loaded=False, error=f"{type(e).__name__}: {e}")
        print(f"[laya] load failed: {e}", file=sys.stderr, flush=True)


def route(body):
    """Pick the best specialist agent for a command; say whether a new one is needed."""
    text = body.get("text")
    agents = body.get("agents") or {}
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text required")
    if not isinstance(agents, dict) or not agents:
        raise ValueError("agents {id: description} required")
    if len(agents) > 200:
        raise ValueError("too many agents (max 200)")
    instructions = body.get("instructions") or (
        "Which specialist agent should handle this developer command? "
        "Pick the agent whose expertise matches the task best."
    )
    threshold = float(body.get("threshold", 0.7))
    agent = STATE["agent"]
    state = {"command": text}
    extra = body.get("extra")
    if isinstance(extra, dict):
        state.update({k: v for k, v in extra.items() if isinstance(v, (str, int, float))})

    criteria = agents
    shortlisted = None
    if len(agents) > SHORTLIST_K:
        # coarse-to-fine: embedding shortlist, then one decision pass on the top-k
        import laya
        embed = laya.embed_fn_from_agent(agent)
        keep = laya.shortlist_choice(state, agents, embed, k=SHORTLIST_K, instructions=instructions)
        criteria = {k: agents[k] for k in keep if k in agents}
        shortlisted = list(criteria.keys())

    questions = {
        "agent": {"type": "choice", "instructions": instructions, "criteria": criteria},
        "needs_new": {"type": "noul", "instructions": (
            "Does this command need a specialist that is NOT in the list above "
            "(none of the listed agents fits the domain well)?")},
        "risk": {"type": "score", "instructions": "How risky is executing this command on a developer workstation?",
                 "criteria": ["read-only or trivial", "modifies files", "destructive or irreversible"]},
    }
    t0 = time.time()
    res = agent.predict(state, questions)
    ans = res["answers"]
    probs = ans["agent"]["probabilities"]
    ranked = sorted(probs.items(), key=lambda kv: kv[1], reverse=True)
    top, p_top = ranked[0]
    return {
        "agent": top,
        "confidence": ans["agent"]["confidence"],
        "probability": p_top,
        "probabilities": probs,
        "alternatives": [{"agent": k, "probability": v} for k, v in ranked[1:4]],
        "needs_new": ans["needs_new"]["noul"],
        "risk": ans["risk"]["score"],
        "decision": "use" if (p_top >= threshold and ans["needs_new"]["noul"] < 0.5) else "create",
        "threshold": threshold,
        "shortlisted": shortlisted,
        "latency_ms": round((time.time() - t0) * 1000, 1),
        "model": MODEL,
        "device": STATE["device"],
        "usage": res.get("usage"),
    }


def shortlist(body):
    """Coarse-to-fine: embedding shortlist of a large option set before one decision pass."""
    import laya
    options = body.get("options") or {}
    if not isinstance(options, dict) or len(options) < 2:
        raise ValueError("options {id: description} required")
    if len(options) > 500:
        raise ValueError("too many options (max 500)")
    k = max(1, min(int(body.get("k", SHORTLIST_K)), len(options)))
    state = body.get("state") if isinstance(body.get("state"), dict) else {"command": str(body.get("state", ""))}
    instructions = body.get("instructions") or "Which option fits the situation best?"
    t0 = time.time()
    embed = laya.embed_fn_from_agent(STATE["agent"])
    keep = laya.shortlist_choice(state, options, embed, k=k, instructions=instructions)
    return {"keep": [x for x in keep if x in options], "k": k, "latency_ms": round((time.time() - t0) * 1000, 1)}


class Handler(BaseHTTPRequestHandler):
    server_version = "aidev-laya/1"

    def log_message(self, fmt, *args):  # quieter access log
        if os.environ.get("LAYA_ACCESS_LOG"):
            super().log_message(fmt, *args)

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            with LOCK:
                s = {k: v for k, v in STATE.items() if k != "agent"}
            s.update(status="ok" if STATE["loaded"] else ("error" if STATE["error"] else "loading"),
                     model=MODEL, release=RELEASE)
            return self._json(200 if STATE["loaded"] else 503, s)
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/route", "/decide", "/shortlist"):
            return self._json(404, {"error": "not found"})
        if not STATE["loaded"]:
            return self._json(503, {"error": "model not loaded", "detail": STATE["error"]})
        n = int(self.headers.get("content-length") or 0)
        if n > 256 * 1024:
            return self._json(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid json"})
        try:
            if self.path == "/route":
                return self._json(200, route(body))
            if self.path == "/shortlist":
                return self._json(200, shortlist(body))
            t0 = time.time()
            res = STATE["agent"].predict(body.get("state"), body.get("questions") or {})
            res["latency_ms"] = round((time.time() - t0) * 1000, 1)
            res["device"] = STATE["device"]
            return self._json(200, res)
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            print(f"[laya] request failed: {e}", file=sys.stderr, flush=True)
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[laya] listening on {PORT}, loading {MODEL} (device={DEVICE}) release={RELEASE}", flush=True)
    srv.serve_forever()
