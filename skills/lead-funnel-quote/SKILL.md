---
name: lead-funnel-quote
display_name: Quote Request Funnel
icon: paper-airplane
source: NXISAI
description: >
  Discover service providers (contractors, attorneys, clinics, agencies,
  dealers) and submit quote or contact requests by querying typed schema.org
  records and executing the entity's QuoteAction/AskAction with the
  nxis_action tool. LEAD_GEN policy — one consent covers a fan-out to up to
  three providers; the business responds asynchronously. Triggers on
  quote/estimate/contact/inquiry with no slot and no payment.
license: Apache-2.0
metadata:
  author: nxisai
  version: 1.1
  type_group: _action
  schema_types: [LocalBusiness, HomeAndConstructionBusiness, Plumber,
    Electrician, ProfessionalService, Attorney, LegalService,
    MedicalBusiness, RealEstateAgent, AutoDealer, FinancialService,
    Organization, SoftwareApplication]
  submit_policy: LEAD_GEN
allowed_tools:
  - nxis_list_types
  - nxis_query
  - nxis_get
  - nxis_action
enabled: true
---

Discover service providers in a NxisAI-indexed corpus with the typed-retrieval tools, then **submit a qualified lead** by executing each provider's resolved `QuoteAction` / `AskAction` through the generic **`nxis_action`** tool.

This is **Lead Funnel · lead mode**: an asynchronous quote or contact request with **no slot commitment and no payment** (`LEAD_GEN` policy). Plumber quotes, attorney consultations, healthcare appointment *requests*, real-estate inquiries, dealer quotes, SaaS demo requests. The business responds later on its own channel — the conversion event is a **lead accepted into the business's queue**, not a held slot or a charge. Uniquely among the funnel modes, lead mode supports **fan-out**: collect the project details once and submit to up to **three** providers under a single consent.

## When this skill applies

Use this skill when **all** of the following are true:

- The user wants a **quote, estimate, consultation, callback, demo, or inquiry** — the business follows up asynchronously
- A NxisAI Site MCP is connected, exposing the typed-retrieval tools **and** the write tool `nxis_action`
- The chosen entity carries a resolved `potentialAction` of `@type` `QuoteAction` or `AskAction`

Do not use this skill for:

- **Slot commitments** (table, appointment time, class) → use **Reservation Funnel** (`ReserveAction`/`ScheduleAction`, `BOOKING`)
- **Paid** conversions (price + checkout) → out of scope; these go through Commerce Checkout (`OrderAction`/`TXN`, UCP), which is not part of this library
- **Applications** carrying regulated PII (jobs, admissions, permits, financial applications) → use **Application Funnel** (`ApplyAction`, `TXN`)
- Discovery only — when the user just wants to find a provider, stop after the retrieval steps

`nxis_action` is a **write tool**: invoking it requires an **authenticated principal** (the MCP API key or an agent OAuth identity). There are no anonymous leads.

## Entry from Typed Retrieval

Typed Retrieval's result cards carry an action button that sends a prompt such as "Get a quote from {name}" or "Contact {name}". The listings agent on a site's own page sends the same text.

- **Trigger.** A CTA prompt (for example "Get a quote from Hatzel & Sons Plumbing") whose subject is among the records already in this conversation enters the funnel at **Step 2**.
- **Skip discovery.** Take that record's `@id` and `nxis_get` it. Do not run `nxis_list_types` or `nxis_query` again. If no record in the conversation matches the name, run Step 1 as usual.
- **Verify, don't trust.** If the fetched record has no `QuoteAction` or `AskAction` (the `@type` may be spelled as a full IRI, `https://schema.org/...`), say so and stop. The prompt is a hint; the record decides.
- **Self-page actions run on the site.** If the action's `target` has `nxis:targetKind: selfPage`, it cannot be submitted with `nxis_action`. Say the form runs on their page, link the target's `nxis:pageUrl`, and stop.
- **Gates stay.** Steps 3 to 5 run unchanged, including Step 3's batch confirmation (one explicit consent naming every provider). The CTA click never counts as consent.

## The pattern, in five steps

### Step 1 — Discover the providers (typed retrieval)

List types, then query for the most-specific provider subtype. Push all filters into a single `nxis_query`.

```json
{
  "method": "tools/call",
  "params": {
    "name": "nxis_query",
    "arguments": {
      "filter": {
        "schema_type": "Plumber",
        "field_filters": [
          { "path": "areaServed.postalCode", "operator": "EQUALS", "value": "48067" },
          { "path": "additionalProperty.emergency_24_7", "operator": "EQUALS", "value": "true" }
        ]
      },
      "limit": 5
    }
  }
}
```

Map intent to the subtype: "plumber/electrician/roofer" → the specific trade type, falling back to `HomeAndConstructionBusiness`/`LocalBusiness`; "attorney/accountant/agency" → `Attorney`/`LegalService`/`ProfessionalService`; "clinic/doctor" → `MedicalBusiness`/`Physician`; "dealer/trade-in" → `AutoDealer`; "insurance/loan quote" → `FinancialService`; "demo/sales contact" → `Organization`/`SoftwareApplication`.

### Step 1b — Present the provider options

When the query returns more than one provider, let the user pick before submitting anything. Because lead mode fans out, the user may pick **up to three**. Do not output a markdown text list — presentation branches on the host environment; check tool availability at runtime and pick the path:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Render the candidates inline as a card grid. Call `visualize:read_me` with `["mockup"]` once, then `visualize:show_widget` with one card per provider. Each card must include:

- Provider `name`, made clickable via `sendPrompt('Request a quote from [name]')` so picking a card **starts the lead flow**
- Schema `@type` as a small outlined badge in the top-right
- Star rating row: amber stars + numeric `aggregateRating.ratingValue` + `(N reviews)` from `reviewCount`
- The lead cue — service categories / `knowsAbout`, `areaServed` locality, license or credential fields when present
- The `@id` hash (final path segment), monospace, in info color, above a dashed top-border separator
- A primary **Request quote** affordance (the clickable name suffices; an explicit button is better) using the accent color tokens
- When more than one candidate is shown, a secondary affordance wired to `sendPrompt('Request quotes from the top 3')` so the fan-out is one click

Use host design tokens so the cards adapt to light/dark mode: `var(--color-background-primary)` card fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners, `repeat(auto-fit, minmax(290px, 1fr))` grid. No hardcoded hex colors.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Append a single `<quote-cards>` tag block at the very end of the response, containing a JSON array of provider objects. Each carries the canonical JSON-LD fields returned by `nxis_query` — `name`, `@type`, `@id`, `aggregateRating`, `address`, `areaServed`, `telephone`, and any other populated fields — passed through unmodified. Don't wrap the tag in a markdown code fence; the host parses the raw tag and renders the cards in its own UI.

**Both paths.** Precede the cards with a short prose intro that names the filter logic in use (e.g. "24/7 plumbers serving 48067, sorted by rating"). Don't summarize beyond what the record carries; omit fields the record doesn't have rather than fabricating. If exactly one provider matches, you may skip straight to Step 2.

### Step 2 — Fetch each entity and read its lead action

`nxis_get` each chosen entity by its `@id`. The returned record carries a **resolved** `potentialAction` whose `@type` is `QuoteAction` or `AskAction`. The action provides three things you need:

- its own `@id` — the handle you pass to `nxis_action`
- `https://nxis.ai/ns#input` — the `PropertyValueSpecification` array (the fields to collect, with `valueRequired` / `valueType`)
- `https://nxis.ai/ns#targetKind: "webhook"` or `"gateway"` — confirms this is a server-side lead sink (not a self-page form)

```json
{ "method": "tools/call", "params": { "name": "nxis_get",
  "arguments": { "id": "https://drain-pros.example/#organization" } } }
```

If the entity's `potentialAction` is a reference (`{"@id": …}`) and the input spec isn't inline, `nxis_get` the **action's** `@id` to read its `nxis:input`. If an entity has **no** `QuoteAction`/`AskAction`, it isn't lead-capable through this corpus — present its contact card (`telephone`, `email`, `url` from the record) instead, and drop it from any fan-out rather than inventing a flow. When fanning out, the input set to collect is the **union of every selected provider's required fields** — collect once, reuse everywhere.

### Step 3 — Collect the details once and confirm the batch

From the actions' `PropertyValueSpecification`s, gather every `valueRequired` field. Typical lead inputs: `name`, `phone` and/or `email`, a project or matter description (`description`, `matter_type`, `service_type`), and context fields like urgency or property type. Apply the **minimum-data principle**: collect and transmit only what the specs require or the user volunteered — never pad the payload.

**Confirm before submitting** — `LEAD_GEN` allows **one consent to cover the whole fan-out batch**, but that consent must be explicit and name every provider. Presentation branches on the host environment:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Once every required field is collected, render a single **review-and-confirm widget** instead of a prose echo. Call `visualize:read_me` with `["mockup"]` first if it hasn't been called this conversation, then `visualize:show_widget` with one card:

- An eyebrow label — "Review quote request" — with the provider `name`(s) listed as the card title (all recipients visible; this is the fan-out consent surface)
- The exact values about to be submitted as label/value rows: the project description and each collected input (`name`, `phone`, `email`, context fields). Nothing that isn't in the payload; nothing fabricated
- A primary **Send request** button (accent color tokens) wired to `sendPrompt('Send the quote request exactly as shown')` — clicking it **is** the user's consent for the whole batch and triggers the Step 4 submissions
- A secondary **Edit details** affordance wired to `sendPrompt('Change the quote request details')`, styled with the outlined/secondary tokens

Use host design tokens (`var(--color-background-primary)` fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners). No hardcoded hex colors. **Do not call `nxis_action` until the user clicks Send** (or affirms explicitly in text) — the widget replaces the prose echo, not the consent gate.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Confirm in prose: echo the payload and every recipient back as a direct question ("Send your burst-pipe quote request — Mike Thompson, 248-555-9876, today after 2pm — to Royal Oak Drain Pros, Mainline Sewer & Drain, and Metro Plumbing?") and wait for an affirmative reply before Step 4.

### Step 4 — Submit the lead(s) with `nxis_action`

Call `nxis_action` once **per provider**, each with that provider's own action `@id` and the shared collected `arguments`:

```json
{
  "method": "tools/call",
  "params": {
    "name": "nxis_action",
    "arguments": {
      "id": "https://drain-pros.example/quote#action",
      "arguments": {
        "name": "Mike Thompson",
        "phone": "+1-248-555-9876",
        "description": "Kitchen drain completely clogged, residential",
        "urgency": "today after 2pm"
      }
    }
  }
}
```

The MCP server fetches the action by `@id`, **validates** your arguments against its `PropertyValueSpecification`s, looks up the tenant's binding (webhook or gateway), and delivers the typed payload — webhook POSTs are **HMAC-signed** (`X-Nxis-Signature`) so the business can verify origin. Because this is `LEAD_GEN`, a `2xx` **is** the conversion: the lead landed in the business's queue. A lead reference in the body is a bonus, not a requirement (unlike `BOOKING`, where the inline reference is mandatory).

**Fan-out rules.** Maximum **three** providers per batch, all named in the Step 3 consent. Submit to each provider **once** — the server dedupes on contact info and rate-limits (3 leads per user per provider per day); never re-POST the same payload to the same provider, including after a failure. One provider's failure does not abort the batch: continue with the rest and report per-provider outcomes.

### Step 5 — Present the outcome

Surface the result as a confirmation card, not a bare line — with **per-provider status** when fanned out. Presentation branches on the host environment:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Call `visualize:read_me` with `["mockup"]` once, then `visualize:show_widget` with a single outcome card:

- A success header (green check, success color tokens) — "Quote request sent"
- One row per provider: `name` + status ("Accepted" on `2xx`, an error state on failure) + the lead reference when the endpoint returned one, monospace
- The honest asynchronous framing as a caption — "Each business will follow up directly at 248-555-9876"
- The `@id` hash(es) (final path segment), monospace, in info color, above a dashed top-border separator

Use host design tokens (`var(--color-background-primary)` fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners). No hardcoded hex colors. If **every** submission failed, render an error state using the danger tokens — never a success card for a batch with zero accepted leads; a mixed batch shows both states honestly, per row.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Append a single `<quote-confirmation>` tag block at the very end of the response, containing a JSON array with one object per provider — `business`, `@type`, `actionStatus` (`CompletedActionStatus` / `FailedActionStatus`), the `lead_reference` when returned, and the source `@id` — passed through unmodified. Don't wrap the tag in a markdown code fence.

**Both paths.** Frame the result as **accepted, not acted upon** — the business follows up on its own schedule; never promise a response or invent a timeline. Show only references the endpoints actually returned; never fabricate one. On a failure, present it honestly and offer to try a different provider (a fresh `nxis_query`), rather than re-POSTing the same payload.

## How `nxis_action` executes a lead

One generic tool runs every server-side action; the lead specifics live entirely in the discovered action's JSON-LD:

1. **Fetch** the action by `@id` (`getEntityByJsonLdId`).
2. **Validate** `arguments` against the action's `PropertyValueSpecification`s (required present, types).
3. **Resolve** the tenant binding for the action's `@type` and deliver the typed payload to the real sink — a webhook POST to a `target_url` that is never agent-visible (HMAC-signed), or a handoff into the tenant's connected gateway apps (Zapier-class, capability handle only).
4. **Return** the result: `2xx` → `CompletedActionStatus` (lead accepted, with any reference from the body), non-`2xx`/timeout → a tool error.

The agent never sees where the payload routes (binding is operational, not discovery); it only needs the action `@id` + inputs, both surfaced by `nxis_get`.

## Best practices

- **Collect once, submit many.** In a fan-out, gather the union of required fields up front — never re-interview the user per provider.
- **Name every recipient in the consent.** One consent covers the batch only if the user saw the full recipient list — the Step 3 review surface, or the prose question, lists all of them.
- **Cap the fan-out at three.** More is spam, and the server rate limit (3/user/provider/day) assumes it.
- **Minimum data.** Transmit only spec-required fields and what the user volunteered; PII rides a signed `POST`, never a GET.
- **Frame results as accepted, not answered.** The business follows up asynchronously — surface any lead reference, promise nothing about timing.
- **Per-provider outcomes, not batch collapse.** One failed submission doesn't sink the batch; report each row honestly.
- **Use the most-specific provider subtype** in discovery (`Plumber`, not `LocalBusiness`).
- **Fall back to the contact card.** A provider without a `QuoteAction`/`AskAction` still has `telephone`/`email`/`url` on its record — present those instead of forcing the flow.

## Anti-patterns

- **Don't submit without explicit consent.** Auto-submit is permitted by `LEAD_GEN` only *after* a consent that named the recipients.
- **Don't re-POST the same lead.** Dedupe is on contact info; a retry after failure or a "did it work?" resubmit double-files the user.
- **Don't promise a response.** No fabricated timelines, no invented lead references, no "they'll call you within the hour."
- **Don't use this for slot commits or payments.** A time slot → Reservation Funnel; regulated-PII applications → Application Funnel; price + checkout is out of scope for this library.
- **Don't fan out reservations or applications.** Fan-out is a `LEAD_GEN`-only affordance.
- **Don't invent the action.** If the entity has no `QuoteAction`/`AskAction`, it isn't lead-capable here — show its contact card.
- **Don't call `nxis_action` unauthenticated.** Write tools require an authenticated principal.

## Worked example

**User:** "Get me quotes from the top 3 plumbers in 48067 for a burst pipe."

1. **Discover** — `nxis_query` `Plumber` filtered by `areaServed.postalCode = 48067` → ranked providers; card grid with a "Request quotes from the top 3" affordance.
2. **Read actions** — `nxis_get` each of the three → each carries a `QuoteAction` (`@id` …`/quote#action`) with inputs `name`, `phone`, `description`; one also requires `property_type`. Union: four fields.
3. **Collect & confirm** — one pass collects "Mike Thompson, 248-555-9876, burst pipe in the basement, residential"; a review widget lists all three recipients and the exact payload with a **Send request** CTA → user clicks Send.
4. **Submit** — three `nxis_action` calls, one per action `@id`, same arguments. Two return `2xx` with references; one times out.
5. **Present** — outcome card: "Royal Oak Drain Pros — Accepted · ROD-20260713-081", "Mainline Sewer & Drain — Accepted · MSD-4412", "Metro Plumbing — Failed (no response; not retried)". Caption: each business follows up directly at the number provided.

## Composing with other skills

- **Typed Retrieval** — hands off the entity `@id` of a discovered provider; this skill owns the lead conversion. It also answers review questions about a provider before the user commits to the fan-out.
- **Reservation Funnel** — the slot-commit counterpart; route there when the user picks a specific time.
- **Application Funnel** — the formal-filing counterpart; route there when the user is applying rather than asking.
- **Quote Agent** — the on-site counterpart. When a `selfPage` quote form's site runs one, the "Get a quote on their page" link (`nxis_handoff`) lands in it, and it takes the request in conversation under the same `LEAD_GEN` rules, one provider per handoff.

The quote skill owns discovery-through-lead-submission. The action `@id` is the execution contract; the entity `@id` is the discovery contract.
