---
name: action-binding
display_name: Action Binding
icon: 🔀
source: NXISAI
description: >
  Route a site's Actions — bookings, quote requests, sign-ups — to a webhook in
  the user's own application: verify the site, bind the action, store the
  signing secret where a redeploy will still find it, and add a handler that
  checks the signature. Use when submissions should reach the user's backend
  rather than running on the page.
license: Apache-2.0
compatibility: >
  Any host. Needs a verified site and an application the user can deploy. Runs
  in the project that receives the submissions.
metadata:
  author: nxisai
  version: 1.0
  type_group: _integration
allowed_tools:
  - nxis_mcp_settings
  - nxis_bind_mcp_action
  - nxis_verify_site
  - nxis_site_tag
enabled: true
---

Send a site's Actions somewhere the user controls. An agent that books a table or requests a quote submits a payload; this skill decides where that payload lands, signs it, and makes sure the receiving application can prove it came from NxisAI.

Onboarding turns Actions on and leaves them bound to the page that declares them, which needs no configuration and is right for most sites. This skill is for the case where that is not enough — the submission has to reach a booking system, a CRM, an internal queue.

## When this skill applies

Use this skill when **all** of the following are true:

- The site is verified — normally by **agentic-site-onboarding**
- The user wants submissions delivered to their own application rather than handled on the page
- You are running in the project that will receive them, and the user can deploy it

Do not use this skill for:

- Turning Actions on in the first place. That is **agentic-site-onboarding**
- Putting Actions on the page as WebMCP tools. That is **site-tag-installation**
- A site that is not verified. Binding is refused for one, and correctly — see Step 2
- Zapier or another external MCP server. That is a dashboard flow; see the table below

## Where a submission can go

| Route | Delivery | Configuration | Choose it when |
|---|---|---|---|
| `browser` | The page that declares the Action runs it | None. The default | The site already handles the form, or an on-page agent does |
| `webhook` | Signed POST to a URL you name | A URL, and a secret to store | The submission must reach a server the user controls |
| `gateway` | Into an external MCP server | OAuth, a chosen tool, pinned arguments | Zapier or a personal MCP server |

**This skill covers `webhook`.** `gateway` needs an OAuth connection and a tool picker that cannot be completed from here — the tool returns the dashboard URL, and that is the right answer, not a failure to work around.

The destination does **not** have to be on the site's own domain. Verification proves the user may speak for the site; where they route their own submissions is their business.

## The pattern, in seven steps

### Step 1 — Read what is there now

Call `nxis_mcp_settings` before proposing anything. Report the current routing in a sentence: whether Actions are generated at all, where the default goes, and any per-action overrides.

If a webhook is already bound, **say so before replacing it.** Someone who has a working integration needs to hear that it is about to change, and a bound webhook they have forgotten about is the most likely cause of a support question later.

### Step 2 — Confirm the site is verified

Binding is refused for an unverified site with `FAILED_PRECONDITION`, because routing a site's Actions is a claim to speak for its domain.

Do not surface that as an error. Call `nxis_verify_site` with `mode` set to `check`. If the site is not verified:

- If the tag is missing, add it — you are in the project, so you can. Then tell the user it needs a deploy before verification will pass
- If the tag is present but unverified, run verification
- If neither is possible here, hand back to **agentic-site-onboarding** and stop

### Step 3 — Ask where submissions should go

This is the one thing that must not be guessed. Ask the user for the URL.

You may **suggest** one you can see — a route in the project, the deployment's domain, an existing webhook handler — but the user names it. A destination invented by an agent sends a customer's booking to a URL nobody chose.

Ask whether it applies to **every** Action or only one kind. Omitting `action` sets the default; naming one (`reserve`, `schedule`, `quote`, `ask`, `apply`, `buy`, `order`, `donate`, `pay`) leaves the rest alone.

### Step 4 — Bind it

```
nxis_bind_mcp_action
  route: "webhook"
  webhook_url: "<the URL the user gave you>"
  action: "<one of the nine, or omit for the default>"
```

The response includes the routing that is now live. If a secret was minted for this binding it also includes `signing_secret` and `secret_is_new: true`.

**A minted secret is returned once.** A later read gives you a preview only. Everything in Step 5 happens before you reply to the user.

### Step 5 — Store the secret before you say anything

A secret that reaches the conversation and nowhere else is gone when the window closes. Write it down first, then report.

**Check the ignore rules first.** Confirm `.env` is in `.gitignore`. If it is not, add it before writing. If the repository has ever tracked `.env`, say so and stop — a secret committed to history needs rotation, not another write on top.

Then, in this order:

1. **`.env`** — add `NXIS_WEBHOOK_SIGNING_SECRET=<secret>`. Match the project's existing convention if it has one; do not invent a second name for the same value
2. **`.env.example`** — add `NXIS_WEBHOOK_SIGNING_SECRET=` with an empty value, so the next person knows it is required
3. **The deployment's own environment** — Netlify, Vercel, Fly, Render, a CI secret. **This is the step that makes it survive a redeploy.** `.env` is usually local-only; a deployed site reads its configuration from the platform. If you can set it with the platform's CLI, do. If you cannot, give the user the exact steps for their platform

Only then reply. Say where it was stored, and that the site needs a redeploy before deliveries will verify.

Do not print the secret back for confirmation. It is in the files; repeating it puts it in the transcript as well.

### Step 6 — Add the handler

A route at the URL from Step 3 that verifies the signature before trusting the body.

Every delivery carries:

```
X-Nxis-Signature: t=<unix-seconds>,v1=<hex>
```

where `v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`.

**Two things make a handler reject every delivery, and both look like the feature is broken:**

- **The HMAC covers the raw bytes.** A framework that parses JSON before your handler sees it gives you a re-serialized body whose signature never matches. Configure raw-body access for this route
- **Compare in constant time.** A plain `===` on the hex leaks the secret a byte at a time

Write it in the project's own framework and conventions. The shape:

```js
// Raw body, not the parsed object.
const raw = await readRawBody(req);
const header = req.headers['x-nxis-signature'] ?? '';
const t = header.match(/t=(\d+)/)?.[1];
const v1 = header.match(/v1=([a-f0-9]+)/)?.[1];
if (!t || !v1) return reject(400);

// Replay protection — refuse anything outside a freshness window.
if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return reject(400);

const expected = crypto
  .createHmac('sha256', process.env.NXIS_WEBHOOK_SIGNING_SECRET)
  .update(`${t}.${raw}`)
  .digest('hex');

const a = Buffer.from(v1, 'hex');
const b = Buffer.from(expected, 'hex');
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reject(401);

// Verified. Now parse, and answer quickly — do the slow work after responding.
const submission = JSON.parse(raw);
```

Answer fast. A booking agent is waiting on the response; queue anything slow rather than holding the request open.

### Step 7 — Confirm, honestly

Call `nxis_mcp_settings` again and show the routing that is now live.

Then say plainly what is and is not working yet:

- The binding is live **now** — NxisAI will start signing and delivering
- The handler is **not** live until the user deploys
- Until then deliveries will fail, and that is expected rather than a misconfiguration

Never imply an endpoint is working when it has only been written to disk.

## Handling something that cannot be recovered

**The secret is shown once.** If it is lost, the fix is rotation, not retrieval — and deliveries fail between rotating and redeploying. Never rotate to recover from a failed write; fix the write.

**Never commit it.** Files, and the platform's environment. Not the repository, not the transcript, not a comment on a ticket.

**One secret per binding slot.** The default and each override have their own. Changing a webhook's URL keeps its secret; the tool tells you, and `secret_is_new` will be absent.

## When to stop and hand back

- **The site is not verified and cannot be from here** — **agentic-site-onboarding**
- **The user wants Zapier or an external MCP server** — the dashboard, Action Binding tab
- **`.env` is tracked in git** — say so, stop, and let the user decide whether to rotate and scrub history
- **You cannot reach the deployment's environment settings** — write the local files, then give the user the exact steps rather than leaving it half-done and implying it works

## Related skills

- **agentic-site-onboarding** — runs before this. It verifies the site and turns Actions on, bound to the page. This skill is what changes where they go
- **site-tag-installation** — the other destination for an Action: onto the page itself as a WebMCP tool. Independent of this skill; a site can have both
- **on-page-agent** — the agent that calls page-bound Actions. Unaffected by a webhook binding, which changes the server-side route only
- **The host's own skills**, when the project has them installed, for setting deployment environment variables and deploying

This skill owns **where a submission lands**: the binding, the secret, and the handler that verifies it. It does not generate Actions, change the site's data, or deploy.

## Tool reference

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_mcp_settings` | Reads the current routing, before and after a change | site, on the provisioning connection |
| `nxis_bind_mcp_action` | Sets the route. Returns a minted secret once | `route`; `webhook_url` for webhooks; `action` for one kind only |
| `nxis_verify_site` | `check` confirms the site is verified, which binding requires | `mode`, site |
| `nxis_site_tag` | Only when verification is missing and the tag has to be added first | `mode`, site |

`nxis_mcp_settings` never changes anything and never returns a secret — a preview only, however the binding was made. `nxis_bind_mcp_action` returns `signing_secret` with `secret_is_new` exactly once, when it mints one; on every later call for the same slot the secret is carried forward and not repeated.
