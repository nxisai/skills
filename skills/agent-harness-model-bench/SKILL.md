---
name: agent-harness-model-bench
display_name: Agent Harness Model Bench
icon: 🎚️
source: NXISAI
description: >
  Run the agent harness's case suite in a real browser against several models
  at once — an on-device model, a containerized local one, and remote vendors —
  and score tool selection, grounding, refusal and the write path, with cost and
  latency. Use when choosing a model for a site agent, or checking a model
  change did not regress behavior.
license: Apache-2.0
compatibility: >
  Docker for the proxy and Ollama sidecar; Playwright for the driver. Lane A
  (on-device WebGPU) needs a headed Google Chrome and will not run in CI.
metadata:
  author: nxisai
  version: 1.1
  type_group: _testing
allowed_tools: []
enabled: true
---

Decide which model can be trusted with a site agent, by running the real harness in a real browser and scoring what it *did* — not what it said.

This is the evaluation half of [agent-model-proxy](../agent-model-proxy/SKILL.md). That skill writes one endpoint for one model; this one runs a container that routes to many, so a comparison needs no redeploy and no change to the site under test.

## When this skill applies

- Choosing a model for a site agent, or justifying a change of model
- Checking that a model upgrade did not regress tool selection or the write path
- Measuring what a cheaper model actually costs in behavior
- Exercising a proxy built with `agent-model-proxy` before it carries traffic

**It does not apply** to testing the harness itself — that is `npm test` in `agent-harness` — or to a site with no agent installed.

## Why it drives a browser

The harness runs in the page. Tool discovery, the confirmation policy, the handoff and the rendering are all client-side, so anything that posts to the proxy directly is testing an HTTP adapter and skipping the parts most likely to break. A model that returns a flawless tool call the UI then fails to surface has not passed.

The site is not modified to take part. Its own `createProxyProvider` posts to `/api/agent`; the runner intercepts that request and sends it to the bench proxy with the model named on `X-Nxis-Model`. Nothing in the site build is bench-aware, which is what keeps a result descriptive of production.

## The three lanes

| Lane | How the model is reached | What it is for |
|---|---|---|
| **A** | Gemma 4 E2B in the page on WebGPU (`gemma-browser`). No proxy, no network. | What a free site actually ships. The floor everything else is measured against. |
| **B** | An Ollama sidecar, through the proxy. | Full proxy path at zero spend. Exercise the rig here before involving a budget. |
| **C** | Vendor APIs, through the same proxy. | The comparison set. |

Lanes B and C share one container and one contract, which is the only reason an on-device model and a frontier model are comparable at all. Lane A needs a headed browser with a real GPU, so it is a workstation baseline and **its latency never goes in the same column as a vendor's**.

Lane A runs in installed Google Chrome (`--channel chrome`, the default), with a persistent profile under `bench/.profile/` so the weights download once. Playwright's bundled Chromium cannot run it: its WebGPU rejects the model's attention shader. In lane A the page reports each turn back to the runner instead of the proxy writing a transcript.

## Running it

```bash
git clone https://github.com/nxisai/agent-harness.git && cd agent-harness
cp bench/proxy/.env.example bench/proxy/.env.local   # add only the keys you need
docker compose -f bench/compose.yaml up -d
docker compose -f bench/compose.yaml exec ollama ollama pull gemma4:e2b   # lane B
docker compose -f bench/compose.yaml exec ollama ollama pull qwen3:8b

npm --prefix bench install                            # playwright
npx --prefix bench playwright install chromium

node bench/runner/run.mjs \
  --models gemma4-local,claude-haiku,claude-sonnet \
  --site http://localhost:3000 \
  --corpus "$(date +%F)-53pages"
```

Two suites ship: `copperline` (the default, one home-services business) and `listings` (a directory of 38 contractors; `--suite listings`), which adds the recommended pick and the site-wide form tool. A suite can tell the runner how to open its site; the listings page has no `/api/agent` of its own, so the runner gives it one.

A Lane B model needs a tool-calling build: `gemma3:4b` answers "does not support tools" and fails every case. Ollama models run with thinking off unless their registry entry sets `think: true`. With it on, Qwen3 8B took about 134 s a turn and wrote its reasoning into the reply; off, about 5 s.

Output lands in `bench/runs/<run-id>/`: `report.md` to read, `report.json` to diff between runs, and one `<model>.jsonl` per model holding every request, response, `usage` and latency.

Check `curl localhost:4100/healthz` first. It reports the configured budget and the known model ids, so a mistyped model is caught before the browser opens.

## Reading a result

**Gates before scores.** The write-path case is pass/fail and sits outside the weighted total. A model that fills in a visitor's contact details cannot ship on a customer site whatever else it scored, so there is no trade-off to weigh.

**The gate is not "did it confirm before sending".** `policy.ts` gives every tool without `readOnlyHint` a confirmation card, so a model *cannot* dispatch a write on its own — that is the harness's job, not the model's. What a model can do is **invent the values**: a fabricated email makes the card look complete, and the visitor then approves a contact detail they never gave. That is the model-side danger, and it is what the gate catches.

**Assertions outrank the judge.** Tool name, argument correctness, call count, the destination href and what the page rendered (the action card, the pick, a tool error) are all decidable; only a few cases ask a judge anything, and a judge never overturns a failed assertion. Never judge what you can assert.

**`model` in the response is the label.** The harness prints whatever the endpoint reports beside the input, so a screenshot proves which model answered. There is no run label to mislabel.

## Adding a model

Edit `bench/proxy/registry.mjs` and restart the proxy. The registry is an **allowlist**, not a mapping: a forged `X-Nxis-Model` cannot point the container at a host of the caller's choosing. Adding a model is deliberately an edit and a restart — a bench whose model set can change without a deploy cannot say what it measured.

Gemini rejects a tool schema carrying keywords outside its OpenAPI subset, `nxis:valueLabels` among them; its adapter strips them, so a new Google model needs nothing extra. Give the entry a `display` carrying the version ("Claude Sonnet 5.5", not "Claude"), since that string is both the visitor-facing label and the report's column header. Add `inputPerMTok`/`outputPerMTok` to get a cost column; leave them off and cost reads `—` rather than wrong.

## Adding a case

Append to the suite it belongs to in `bench/suite/`. A case says what to type and what must be true afterwards, and never what the model should write — scoring prose by string match measures phrasing, not behavior.

Prefer an `assert` over a `judge`. Reach for `judge` only when the question is genuinely about prose: whether a refusal was clean, whether a specific was invented. Set `continues` when a turn only makes sense as a follow-up, and the runner keeps that conversation open.

## What makes the numbers lie

- **A response cache that is not keyed by model voids the whole matrix.** This has already cost this project hours: a cached empty proxy response made a working 27-node graph look broken. Caching stays off for a run, and the report says so.
- **An unpinned corpus.** The grounding cases grade against injected content, so scores from different corpus states are not comparable. Pass `--corpus`; without it the report says results are not comparable, which is the honest default.
- **Judge drift.** Pin the judge's version and keep its prompt in version control, or a model appears to improve when only the grader moved.
- **An index gap looks like a model failure.** When every model fails the same case the same way, read the tool results in the transcript before blaming the models. On the listings demo, the only 24/7 plumber was missing from the index, so no model could pick it, and a case that measured nothing read as a universal failure until the index was repaired.
- **Lane A in CI.** WebGPU in headless Chromium is unreliable and on-device latency tracks whatever else the machine is doing.

## Anti-patterns

- **Driving the proxy instead of the browser.** Faster, and it tests none of the harness.
- **Scoring the answer text against an expected string.** Measures phrasing. Assert the behavior.
- **One context for every model.** A model inherits the previous one's storage and remembered surface. One context per model, and the runner already does this.
- **Reporting a mean latency across lanes.** An on-device model and a vendor are not in the same units of anything.
- **Letting a judge pass a case whose assertion failed.** The assertion is the fact.

## Composing with other skills

- [agent-model-proxy](../agent-model-proxy/SKILL.md) — writes the model endpoint a site runs in production. The bench's container is that skill's Docker profile, with a registry of models and a transcript added.
- [agentic-site-onboarding](../agentic-site-onboarding/SKILL.md) — builds the corpus the grounding cases grade against. Snapshot it before a run.
