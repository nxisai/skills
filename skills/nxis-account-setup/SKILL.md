---
name: nxis-account-setup
display_name: Account Setup
icon: 🔑
source: NXISAI
description: >
  Get a user from no NxisAI account to a working provisioning connection, from
  the terminal: sign in with Google, name the organization, choose a plan, and
  install the MCP key into this agent's config. Use before
  agentic-site-onboarding when there is no provisioning connection yet.
license: Apache-2.0
compatibility: >
  Any host. Needs a terminal and a browser the user can reach. Drives the
  @nxisai/cli tool through the shell; no NxisAI MCP tools, since there is no
  connection yet.
metadata:
  author: nxisai
  version: 1.0
allowed_tools: []
enabled: true
---

Take a user who has never used NxisAI from nothing to a provisioning MCP connection this agent can use — without sending them to a dashboard and back.

Every other skill in this library starts by assuming a connection already exists. This is the one that creates it. It runs entirely through `@nxisai/cli`, which you drive from the shell.

Two steps belong to the user and cannot be done for them: signing in with Google, and paying. Everything else is yours. The CLI is built so you can tell those apart without seeing their browser.

## When this skill applies

Use this skill when **all** of the following are true:

- There is no working NxisAI provisioning connection — no `nxis-onboarding` MCP server, or its tools fail with a permission error
- The user wants to set a site up on NxisAI
- The user can open a browser and is present to do so

Do not use this skill for:

- A user who already has an organization and an API key. Configure the MCP server directly and go to **agentic-site-onboarding**
- Adding a second site to an existing account. That is **agentic-site-onboarding** on its own
- Buying credits for an account that is already set up. That is `nxis credits buy` on its own, and it needs no skill

## The contract you are working against

Every command takes `--json` and prints exactly one object. Read the exit code first — it tells you which of three situations you are in, and only one of them is a problem.

| Exit | Means | Do |
|---|---|---|
| `0` | Done | Continue to the next step |
| `2` | Needs the user | Relay the message. **Never retry the command** |
| `3` | Not authorized | Run `nxis login` |
| `1` | Failed | Report the error as given |

Exit `2` is the important one. It is not a failure, and treating it as one is how an agent opens a second checkout for someone who has already paid. The JSON carries a `reason` field to branch on — `sign_in_required`, `choose_plan`, `payment_pending`, `no_active_plan` — and the fields needed to act on it.

## The pattern, in seven steps

### Step 1 — Find out what is already true

```bash
npx -y @nxisai/cli status --json
```

This never fails for "not signed in" — that is an answer, not an error. Read it and skip every step already done. A user coming back after a half-finished attempt may need nothing but step 6.

### Step 2 — Sign in

```bash
npx -y @nxisai/cli login
```

The command prints a URL and a short code, then waits. **Relay both exactly as printed.** Tell the user to check that the code shown on the page matches the one in the terminal — that check is what stops a relayed link being used against them.

Never ask the user to type a password, a Google verification code, or a one-time code into this conversation. Nothing in this flow requires it. If a user offers one, tell them not to.

If the terminal has no browser — a container, an SSH session — the URL still works from any device, including a phone.

### Step 3 — Name the organization

Ask what the organization should be called. The site's own name is usually right; the project directory usually is not.

```bash
npx -y @nxisai/cli orgs create --name "Acme Roofing" --website "https://acme.example"
```

If the user started signing up in a browser at some point, an empty organization may already exist. The command reuses it rather than leaving a second one behind — `reused: true` in the JSON says that is what happened.

### Step 4 — Put the plans to the user

```bash
npx -y @nxisai/cli plans --json
```

Present them as numbered choices with the price and the credit grant, add **Cancel**, and wait for an explicit pick.

- Never choose a paid plan on the user's behalf
- "Set me up", "do whatever you need", and silence are **not** consent to be charged
- Name the price and the interval in the message where you ask

A typical first setup has three sensible shapes. Offer them in this order:

1. **Free** — no card, a one-time credit grant, enough to onboard a small site
2. **Free plus a credit top-up** — the free plan, then a one-time pack for more headroom
3. **A paid plan** — a recurring grant, for a site that will be re-generated regularly

### Step 5 — Activate it

For the free plan:

```bash
npx -y @nxisai/cli subscribe free
```

For a paid plan, the CLI prints the amount and opens Stripe, then waits:

```bash
npx -y @nxisai/cli subscribe starter
```

Card details go to Stripe and never touch you, the CLI, or this conversation. While it waits, tell the user what it is waiting for — the terminal cannot see their browser tab and neither can you.

If it exits `2` with `payment_pending`, **do not run `subscribe` again.** A second run opens a second checkout and can charge twice. Wait, then run `status`.

**Buying a top-up has an order that matters.** Credits are granted onto a quota row that only exists once the organization has a plan. Buying before then takes the money and grants nothing, and unpicking that needs a human. So always:

```bash
npx -y @nxisai/cli subscribe free      # first — creates the credits row
npx -y @nxisai/cli credits packs       # see what is buyable
npx -y @nxisai/cli credits buy nxc-1000
```

The CLI refuses `credits buy` when there is no active plan rather than letting the payment through. If you see `no_active_plan`, subscribe first — do not work around it.

### Step 6 — Install the connection

```bash
npx -y @nxisai/cli mcp install
```

This mints an MCP key and writes it straight into this agent's MCP configuration. It reports a preview like `…Qx4` and never prints the key itself — which is the point, because anything printed here is in the transcript, the logs, and any summary made later.

Do not ask the user to paste an API key into the chat. Do not run `--print` unless the user explicitly asks to configure something by hand.

Then tell the user how to reload MCP servers. In Claude Code that is `/mcp`. The new tools do not exist until they do this.

### Step 7 — Hand off

Confirm the organization's name and website with the user, then finish the record:

```bash
npx -y @nxisai/cli orgs update --website "https://acme.example" --industry "Roofing"
```

Then run **agentic-site-onboarding**, passing the organization id and, if you have it, the site URL. That skill takes over at "create the site".

## What to say while waiting

Two steps end with the CLI polling something a person is doing somewhere you cannot see. Say which one is happening, and what will end it:

- Signing in: *"I've opened the sign-in page. Enter the code `QRTL-WMXK` — I'll pick it up automatically once you confirm."*
- Paying: *"That's $39/month. I've opened Stripe — the terminal is watching for the payment to clear, so there's nothing to paste back."*

Do not describe a wait as a failure, do not invent progress you cannot observe, and do not claim the payment succeeded until the command returns `0`.

## If something goes wrong

| What you see | What it means | Do |
|---|---|---|
| `sign_in_required` | No usable session | `nxis login` |
| `no_account_claim` | Signed in, but no NxisAI account is attached | Retry login once; if it persists, the tenant is misconfigured — tell the user, do not loop |
| `choose_plan` | Waiting on a decision | Put the options to the user |
| `payment_pending` | Stripe has not confirmed yet | Wait, then `status`. Never re-run `subscribe` |
| `no_active_plan` | Top-up attempted before a plan exists | `subscribe free` first |
| `server_exists` | An `nxis-onboarding` server is already configured | Ask before replacing it — it may point at a different organization |

## What this skill never does

- Ask for a password, a Google code, or a card number
- Print an API key, an access token, or a refresh token
- Choose or change a paid plan without an explicit yes
- Retry a payment command after a timeout
- Write a key into the project rather than the agent's config
