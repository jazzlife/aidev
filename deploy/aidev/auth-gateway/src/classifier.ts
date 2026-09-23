/**
 * Lexical routing prior: a multinomial naive-Bayes classifier over agent example commands
 * (IMPLEMENTATION-PLAN §3.1 addendum). Laya zero-shot is a weak 13-way chooser (~45% measured), while
 * developer commands are vocabulary-heavy (framework, tool and file names), so a tiny classifier
 * trained on per-agent examples carries most of the signal until Laya is fine-tuned (E-07).
 * Tokens: lowercase word tokens (+ word bigrams) for Latin script, character bigrams/trigrams for
 * Hangul so Korean particles do not fragment the signal. Rebuilt whenever examples change.
 */
export type Example = { text: string; agent: string };

const LATIN = /[a-z0-9][a-z0-9+#._/-]*/g;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const words = lower.match(LATIN) ?? [];
  for (let i = 0; i < words.length; i++) {
    tokens.push(words[i]);
    if (i + 1 < words.length) tokens.push(`${words[i]}_${words[i + 1]}`);
  }
  // Hangul: character n-grams inside each run of Hangul syllables
  for (const run of lower.match(/[가-힣]+/g) ?? []) {
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    for (let i = 0; i + 2 < run.length; i++) tokens.push(run.slice(i, i + 3));
  }
  return tokens;
}

export class NaiveBayesRouter {
  private counts = new Map<string, Map<string, number>>();
  private totals = new Map<string, number>();
  private docs = new Map<string, number>();
  private vocab = new Set<string>();
  private trained = 0;

  get size() { return this.trained; }
  get agents() { return [...this.docs.keys()]; }
  /** Number of example documents behind an agent (0 = only its description pseudo-doc or nothing). */
  count(agent: string) { return this.docs.get(agent) ?? 0; }

  train(examples: Example[]) {
    this.counts.clear(); this.totals.clear(); this.docs.clear(); this.vocab.clear(); this.trained = 0;
    for (const example of examples) {
      const tokens = tokenize(example.text);
      if (!tokens.length) continue;
      const bag = this.counts.get(example.agent) ?? new Map<string, number>();
      for (const token of tokens) { bag.set(token, (bag.get(token) ?? 0) + 1); this.vocab.add(token); }
      this.counts.set(example.agent, bag);
      this.totals.set(example.agent, (this.totals.get(example.agent) ?? 0) + tokens.length);
      this.docs.set(example.agent, (this.docs.get(example.agent) ?? 0) + 1);
      this.trained++;
    }
  }

  /** Posterior over agents (Laplace-smoothed, log-space, uniform class prior so small catalogs are not penalised). */
  predict(text: string, candidates?: string[]): Record<string, number> {
    const tokens = tokenize(text);
    const agents = (candidates ?? this.agents).filter((a) => this.docs.has(a));
    if (!agents.length || !tokens.length) return {};
    const v = this.vocab.size || 1;
    const logs = agents.map((agent) => {
      const bag = this.counts.get(agent)!; const total = this.totals.get(agent)!;
      let lp = 0;
      for (const token of tokens) lp += Math.log(((bag.get(token) ?? 0) + 0.5) / (total + 0.5 * v));
      return lp;
    });
    const max = Math.max(...logs);
    const exps = logs.map((lp) => Math.exp(lp - max));
    const z = exps.reduce((a, b) => a + b, 0);
    return Object.fromEntries(agents.map((agent, i) => [agent, exps[i] / z]));
  }
}

/**
 * Fuses Laya's choice probabilities with the lexical prior in log space:
 *   p ∝ p_laya^α · p_nb^(1-α)   (α = LAYA_WEIGHT, tuned on the held-out bench set)
 * Falls back to whichever side is available. Both inputs are over the same agent names.
 */
export function fuse(laya: Record<string, number> | null, nb: Record<string, number> | null, alpha = 0.5, alphaFor?: (name: string) => number): Record<string, number> {
  if (!laya && !nb) return {};
  if (!laya) return nb!;
  if (!nb || Object.keys(nb).length === 0) return laya;
  const names = Object.keys(laya);
  const eps = 1e-6;
  // Agents the lexical model knows little about (a freshly created agent) keep Laya's opinion:
  // their alpha leans toward Laya so a sparse pseudo-document cannot bury a confident pick.
  const scores = names.map((name) => { const a = alphaFor ? alphaFor(name) : alpha; return a * Math.log((laya[name] ?? 0) + eps) + (1 - a) * Math.log((nb[name] ?? 0) + eps); });
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const z = exps.reduce((a, b) => a + b, 0);
  return Object.fromEntries(names.map((name, i) => [name, exps[i] / z]));
}
