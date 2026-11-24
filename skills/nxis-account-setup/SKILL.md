---
name: nxis-account-setup
display_name: Account Setup
icon: key
source: NXISAI
description: >
  Get a user from no NxisAI account to a working provisioning connection, from
  their agent: install the local MCP server, then sign in with Google, name the
  organization and choose a plan through its dialogs, or through the CLI when
  the agent cannot show them. Use before agentic-site-onboarding when there is
  no provisioning connection yet.
license: Apache-2.0
compatibility: >
  Any host. Needs a shell to run the @nxisai/cli tool once (it installs the
  local MCP server) and a browser the user can reach. Needs CLI 0.2.0 or
  later, whose local MCP server (nxis mcp serve) has the organization and plan
  tools and their dialogs (MCP elicitation); in a client that cannot elicit,
  every step runs through the CLI.
metadata:
  author: nxisai
  version: 1.2
allowed_tools:
  - nxis_list_orgs
  - nxis_use_org
  - nxis_create_org
  - nxis_choose_plan
enabled: true
---

Take a user who has never used NxisAI from nothing to a provisioning MCP connection this agent can use — without sending them to a dashboard and back.

Every other skill in this library starts by assuming a connection already exists. This is the one that creates it. One shell command installs the local MCP server (`nxis mcp serve`), which needs no key and no sign-in to install. From then on, in a client that can show the server's dialogs (MCP elicitation; Claude Code can), the server's tools and dialogs do the rest. In a client that can't, every step runs through `@nxisai/cli`, which you drive from the shell.

Two steps belong to the user and cannot be done for them: signing in with Google, and paying. Everything else is yours. On the local server, both come to the user as a dialog that takes them to the right page and waits; on the CLI, the command does the same in the shell.

## When this skill applies

Use this skill when **all** of the following are true:

- There is no working NxisAI provisioning connection — no `nxis-onboarding` MCP server, or its tools fail with a permission error
- The user wants to set a site up on NxisAI
- The user can open a browser and is present to do so

Do not use this skill for:

- A user who already has an organization and an API key. Configure the MCP server directly and go to **agentic-site-onboarding**
- Adding a second site to an existing account. That is **agentic-site-onboarding** on its own
- Buying credits for an account that is already set up. On the local server, `nxis_bulk_autofill` `submit` offers the packs when a run needs them; otherwise `nxis credits buy` on its own, which needs no skill

## Step 1 — Install the local MCP server

Ask once, early, how the agent connects, as **agentic-site-onboarding** step 0 does: **the local MCP server, recommended** when the client can elicit (Claude Code can); the **CLI** when it can't, or the user prefers commands; the **remote** server last, only when the agent can't start a local process.

```bash
npx -y @nxisai/cli@latest mcp install
```

It writes a command, not a key, into this agent's MCP configuration: the server it starts uses the CLI's own sign-in, so nothing secret is written and nothing is minted. It may warn that nobody is signed in or no organization is selected; on the local server that is expected, and the next steps take care of both. `server_exists` means an `nxis-onboarding` server is already configured: ask before replacing it (`--force`), since it may point at another organization.

Then tell the user how to reload MCP servers. In Claude Code that is `/mcp`. The tools do not exist until they do this.

On the CLI transport, skip this step until step 6.

## On the local MCP server

Each tool returns one JSON object. A failure comes back with `isError: true`, a `reason` to branch on, and, for the organization tools, `next`: the call that meets it. **When a dialog asks the user, that is the question: do not ask it in the conversation too**, before or after. Say in a line what the dialog will show, make the call, and report what comes back. `declined_by_user` or `cancelled_by_user` means nothing was done; do not call again unless the user asks.

### Step 2 — Sign in, and find what is already true

Call `nxis_list_orgs`. Made while signed out, it shows the user the sign-in link and code in a dialog, waits for them to sign in, then runs: say that it will, and do not relay the link a second time. Tell the user to check the code on the page matches the one in the dialog — that check is what stops a relayed link being used against them. Its result has `orgs`, each with `current`, and `current_org_id`.

Only a client that cannot show the dialog answers `signed_out` or `session_expired`: then run `npx -y @nxisai/cli@latest login` yourself, relay the URL and code as printed, wait for it to finish, and call the tool again; no restart is needed.

Never ask the user to type a password, a Google verification code, or a one-time code into this conversation. Nothing in this flow requires it. If a user offers one, tell them not to.

### Step 3 — The organization

- **One:** use it
- **Several:** ask which, naming each, then `nxis_use_org` with its id or exact name. The next call acts on it at once. `org_pinned` means the server was started with `--org`; the user changes its config to switch
- **None:** ask what it should be called (the site's own name is usually right; the project directory usually is not), and for the website and industry if they know them. Then `nxis_create_org` with `name`, and `website` and `industry` when given. The server asks the user's yes in a dialog. An empty organization left by a browser sign-up is reused rather than duplicated (`reused: true`)

### Step 4 — The plan

Call `nxis_choose_plan`. When the organization already has a plan, it says which and changes nothing. Otherwise it shows the user the plans, with each one's price, interval and credit grant, in a dialog: a free plan starts at once; a paid one opens its payment page and the call waits until the payment clears. Card details go to the payment page and never touch you, the CLI, or this conversation. Do not put the plans in the conversation first, and do not ask again afterwards.

Credit packs come when a billed run needs them: `nxis_bulk_autofill` `submit` reads the real balance and offers them in its own dialog (**agentic-site-onboarding** step 8).

A client that cannot ask returns `confirmation_unavailable`, with `would_do` and the `terminal_command`. Then continue on the CLI from its "Step 4 — Put the plans to the user", putting the plans to the user yourself.

### Step 5 — Hand off

Run **agentic-site-onboarding** on the same server, from step 4 ("create the site"), passing the site URL if you have it. The organization and plan steps there will find what this skill did and skip them.

## On the CLI

Every command takes `--json` and prints exactly one object. Read the exit code first — it tells you which of three situations you are in, and only one of them is a problem.

| Exit | Means | Do |
|---|---|---|
| `0` | Done | Continue to the next step |
| `2` | Needs the user | Relay the message. **Never retry the command** |
| `3` | Not authorized | Run `nxis login` |
| `1` | Failed | Report the error as given |

Exit `2` is the important one. It is not a failure, and treating it as one is how an agent opens a second checkout for someone who has already paid. The JSON carries a `reason` field to branch on — `sign_in_required`, `choose_plan`, `payment_pending`, `no_active_plan` — and the fields needed to act on it.

### Step 1 — Find out what is already true

```bash
npx -y @nxisai/cli@latest status --json
```

This never fails for "not signed in" — that is an answer, not an error. Read it and skip every step already done. A user coming back after a half-finished attempt may need nothing but step 6.

### Step 2 — Sign in

```bash
npx -y @nxisai/cli@latest login
```

The command prints a URL and a short code, then waits. **Relay both exactly as printed.** Tell the user to check that the code shown on the page matches the one in the terminal — that check is what stops a relayed link being used against them.

Never ask the user to type a password, a Google verification code, or a one-time code into this conversation. Nothing in this flow requires it. If a user offers one, tell them not to.

If the terminal has no browser — a container, an SSH session — the URL still works from any device, including a phone.

### Step 3 — Name the organization

Ask what the organization should be called. The site's own name is usually right; the project directory usually is not.

```bash
npx -y @nxisai/cli@latest orgs create --name "Acme Roofing" --website "https://acme.example"
```

If the user started signing up in a browser at some point, an empty organization may already exist. The command reuses it rather than leaving a second one behind — `reused: true` in the JSON says that is what happened. With several organizations, `nxis orgs use <id|name>` picks the one the user means.

### Step 4 — Put the plans to the user

```bash
npx -y @nxisai/cli@latest plans --json
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
npx -y @nxisai/cli@latest subscribe free
```

For a paid plan, the CLI prints the amount and opens Stripe, then waits:

```bash
npx -y @nxisai/cli@latest subscribe starter
```

Card details go to Stripe and never touch you, the CLI, or this conversation. While it waits, tell the user what it is waiting for — the terminal cannot see their browser tab and neither can you.

If it exits `2` with `payment_pending`, **do not run `subscribe` again.** A second run opens a second checkout and can charge twice. Wait, then run `status`.

**Buying a top-up has an order that matters.** Credits are granted onto a quota row that only exists once the organization has a plan. Buying before then takes the money and grants nothing, and unpicking that needs a human. So always:

```bash
npx -y @nxisai/cli@latest subscribe free      # first — creates the credits row
npx -y @nxisai/cli@latest credits packs       # see what is buyable
npx -y @nxisai/cli@latest credits buy nxc-1000
```

The CLI refuses `credits buy` when there is no active plan rather than letting the payment through. If you see `no_active_plan`, subscribe first — do not work around it.

### Step 6 — Install the connection

On the CLI transport there is no MCP connection yet. For an agent that can start a local process, install the local server (Step 1 at the top): it holds no key. Only when it can't:

```bash
npx -y @nxisai/cli@latest mcp install --remote
```

This mints an MCP key and writes it straight into this agent's MCP configuration. It reports a preview like `…Qx4` and never prints the key itself — which is the point, because anything printed here is in the transcript, the logs, and any summary made later.

Do not ask the user to paste an API key into the chat. Do not run `--print` unless the user explicitly asks to configure something by hand.

Then tell the user how to reload MCP servers. In Claude Code that is `/mcp`. The new tools do not exist until they do this.

### Step 7 — Hand off

Confirm the organization's name and website with the user, then finish the record:

```bash
npx -y @nxisai/cli@latest orgs update --website "https://acme.example" --industry "Roofing"
```

Then run **agentic-site-onboarding**, passing the organization id and, if you have it, the site URL. That skill takes over at "create the site".

## What to say while waiting

Two steps end with the server or the CLI waiting on something a person is doing somewhere you cannot see. Say which one is happening, and what will end it:

- Signing in, on the local server: *"A dialog will show you a sign-in link and a code. Check the code on the page matches; I'll carry on once you've signed in."*
- Signing in, on the CLI: *"I've opened the sign-in page. Enter the code `QRTL-WMXK` — I'll pick it up automatically once you confirm."*
- Paying: *"That's $39/month. I've opened Stripe — the terminal is watching for the payment to clear, so there's nothing to paste back."*

Do not describe a wait as a failure, do not invent progress you cannot observe, and do not claim the payment succeeded until the command returns `0`.

## If something goes wrong

| What you see | What it means | Do |
|---|---|---|
| `sign_in_required`, `signed_out`, `session_expired` | No usable session, and no dialog could show the sign-in | `nxis login`, then the call again |
| `no_account_claim` | Signed in, but no NxisAI account is attached | Retry login once; if it persists, the tenant is misconfigured — tell the user, do not loop |
| `choose_plan` | Waiting on a decision | Put the options to the user |
| `payment_pending` | Stripe has not confirmed yet | Wait, then `status`. Never re-run `subscribe` |
| `no_active_plan` | Top-up attempted before a plan exists | `subscribe free` first |
| `server_exists` | An `nxis-onboarding` server is already configured | Ask before replacing it — it may point at a different organization |
| `confirmation_unavailable` | The client cannot show the server's dialog | Put the decision to the user yourself, then continue on the CLI |
| `declined_by_user`, `cancelled_by_user` | The user said no in a dialog | Nothing was done. Do not call again unless they ask |
| `org_pinned` | The local server was started with `--org` | It keeps acting on that organization; the user changes its config to switch |

## What this skill never does

- Ask for a password, a Google code, or a card number
- Print an API key, an access token, or a refresh token
- Choose or change a paid plan without an explicit yes
- Ask in the conversation what a server dialog asked, or ask again after the user answered there
- Retry a payment command after a timeout
- Write a key into the project rather than the agent's config
