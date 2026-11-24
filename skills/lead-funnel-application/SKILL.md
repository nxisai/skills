---
name: lead-funnel-application
display_name: Application Funnel
icon: clipboard-document-list
source: NXISAI
description: >
  Discover application targets (job postings, academic programs, rental
  listings, permits, financial products) and file a reviewed application by
  querying typed schema.org records and executing the entity's ApplyAction
  with the nxis_action tool. TXN policy — mandatory full-payload review,
  per-field consent, no auto-submit, no blind resubmission. Triggers on
  apply/application/file/submit for a posting, program, listing, or permit.
license: Apache-2.0
metadata:
  author: nxisai
  version: 1.1
  type_group: _action
  schema_types: [JobPosting, Course, EducationalOrganization,
    RealEstateListing, GovernmentService, GovernmentOffice,
    FinancialService]
  submit_policy: TXN
allowed_tools:
  - nxis_list_types
  - nxis_query
  - nxis_get
  - nxis_action
enabled: true
---

Discover an application target in a NxisAI-indexed corpus with the typed-retrieval tools, then **file a reviewed application** by executing the entity's resolved `ApplyAction` through the generic **`nxis_action`** tool.

This is **Lead Funnel · application mode**: a high-stakes, high-PII submission under the **`TXN`** policy. Job applications, admissions, rental applications, permits, financial product applications. Unlike a lead (fire-and-forget contact info) or a reservation (a slot), an application carries a payload that can span dozens of fields — work history, references to documents, sometimes regulated data classes. The conversion event is a **filed application**, and the policy inversion is absolute: **mandatory full-payload review before submit, per-field consent, no auto-submit ever, no blind resubmission**.

## When this skill applies

Use this skill when **all** of the following are true:

- The user wants to **apply / file / formally submit** — to a job, program, rental, permit, or financial product
- A NxisAI Site MCP is connected, exposing the typed-retrieval tools **and** the write tool `nxis_action`
- The chosen entity carries a resolved `potentialAction` of `@type` `ApplyAction`

Do not use this skill for:

- **Quote / contact / inquiry** requests where the business follows up with no formal filing (a rental *tour* is a lead) → use **Quote Request Funnel** (`QuoteAction`/`AskAction`, `LEAD_GEN`)
- **Slot commitments** (an interview time, a gov-office appointment) → use **Reservation Funnel** (`ReserveAction`/`ScheduleAction`, `BOOKING`)
- **Paid** conversions (application fees at checkout, tuition payment) → out of scope; these go through Commerce Checkout (`OrderAction`/`TXN`, UCP), which is not part of this library
- Discovery only — when the user just wants to find postings or programs, stop after the retrieval steps

`nxis_action` is a **write tool**: invoking it requires an **authenticated principal** (the MCP API key or an agent OAuth identity). There are no anonymous applications.

## Entry from Typed Retrieval

Typed Retrieval's result cards carry an action button that sends a prompt such as "Apply to {title}". The listings agent on a site's own page sends the same text.

- **Trigger.** A CTA prompt (for example "Apply to Senior Engineer") whose subject is among the records already in this conversation enters the funnel at **Step 2**.
- **Skip discovery.** Take that record's `@id` and `nxis_get` it. Do not run `nxis_list_types` or `nxis_query` again. If no record in the conversation matches the name, run Step 1 as usual.
- **Verify, don't trust.** If the fetched record has no `ApplyAction` (the `@type` may be spelled as a full IRI, `https://schema.org/...`), say so and stop. The prompt is a hint; the record decides.
- **Self-page actions run on the site.** If the action's `target` has `nxis:targetKind: selfPage`, it cannot be submitted with `nxis_action`. Say the form runs on their page, link the target's `nxis:pageUrl`, and stop.
- **Gates stay.** Steps 3 to 5 run unchanged, including Step 3's per-field consent and full-payload review. The CTA click never counts as consent.

## The pattern, in five steps

### Step 1 — Discover the application target (typed retrieval)

List types, then query for the most-specific target subtype. Push all filters into a single `nxis_query`.

```json
{
  "method": "tools/call",
  "params": {
    "name": "nxis_query",
    "arguments": {
      "filter": {
        "schema_type": "JobPosting",
        "field_filters": [
          { "path": "hiringOrganization.name", "operator": "EQUALS", "value": "Acme" },
          { "path": "title", "operator": "CONTAINS", "value": "Senior Engineer" }
        ]
      },
      "limit": 5
    }
  }
}
```

Map intent to the subtype: "job/role/position" → `JobPosting`; "program/admission/enrollment" → `Course`/`EducationalOrganization`; "rental application" → `RealEstateListing`; "permit/license/benefit" → `GovernmentService`; "loan/account/coverage application" → `FinancialService`.

### Step 1b — Present the candidate targets

When the query returns more than one target, let the user pick before collecting anything. Do not output a markdown text list — presentation branches on the host environment; check tool availability at runtime and pick the path:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Render the candidates inline as a card grid. Call `visualize:read_me` with `["mockup"]` once, then `visualize:show_widget` with one card per target. Each card must include:

- Target `title`/`name`, made clickable via `sendPrompt('Apply to [title]')` so picking a card **starts the application**
- Schema `@type` as a small outlined badge in the top-right
- The application cues the record carries — `hiringOrganization`/`provider` name, location or `applicationDeadline`, salary/tuition/rent fields when present
- The `@id` hash (final path segment), monospace, in info color, above a dashed top-border separator
- A primary **Apply** affordance (the clickable title suffices; an explicit button is better) using the accent color tokens

Use host design tokens so the cards adapt to light/dark mode: `var(--color-background-primary)` card fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners, `repeat(auto-fit, minmax(290px, 1fr))` grid. No hardcoded hex colors. **No "apply to all" affordance** — applications are per-target commitments; each one the user wants gets its own full flow.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Append a single `<application-cards>` tag block at the very end of the response, containing a JSON array of target objects. Each carries the canonical JSON-LD fields returned by `nxis_query` — `title`/`name`, `@type`, `@id`, `hiringOrganization`/`provider`, `applicationDeadline`, and any other populated fields — passed through unmodified. Don't wrap the tag in a markdown code fence; the host parses the raw tag and renders the cards in its own UI.

**Both paths.** Precede the cards with a short prose intro that names the filter logic in use (e.g. "Senior Engineer roles at Acme, newest first"). Don't summarize beyond what the record carries; omit fields the record doesn't have rather than fabricating. If exactly one target matches, you may skip straight to Step 2.

### Step 2 — Fetch the entity and read its application action

`nxis_get` the chosen entity by its `@id`. The returned record carries a **resolved** `potentialAction` whose `@type` is `ApplyAction`. The action provides three things you need:

- its own `@id` — the handle you pass to `nxis_action`
- `https://nxis.ai/ns#input` — the `PropertyValueSpecification` array (the fields to collect, with `valueRequired` / `valueType`)
- `https://nxis.ai/ns#targetKind: "webhook"` — confirms this is a server-side intake (not a self-page form)

```json
{ "method": "tools/call", "params": { "name": "nxis_get",
  "arguments": { "id": "https://careers.acme.example.com/jobs/8841#posting" } } }
```

If the entity's `potentialAction` is a reference (`{"@id": …}`) and the input spec isn't inline, `nxis_get` the **action's** `@id` to read its `nxis:input`. If the entity has **no** `ApplyAction`, it isn't applicable-to through this corpus — present the record's own application URL or contact card instead of inventing a flow.

### Step 3 — Collect with per-field consent, then full-payload review

Application payloads are large. Collect every `valueRequired` field conversationally, honoring three `TXN` rules that don't exist in the other modes:

1. **Per-field consent.** Transmit only fields the user explicitly provided or approved. Never pad the payload from context, prior conversation, or inference — an unasked-for field is an unapproved field, even if you happen to know the value.
2. **Documents by reference, never raw.** Résumés, transcripts, and IDs ride as references (`resume_ref`, `transcript_ref` — a URL or document handle the spec's `valueType` calls for), not as inline content. If the user offers raw regulated data the spec doesn't require, decline it.
3. **Mandatory full-payload review.** Before any submission, the user sees the **complete** payload — every field, every value, nothing elided. This review is not optional and cannot be replaced by a summary.

Presentation branches on the host environment:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Once every required field is collected, render a single **full-payload review widget**. Call `visualize:read_me` with `["mockup"]` first if it hasn't been called this conversation, then `visualize:show_widget` with one card:

- An eyebrow label — "Review application" — above the target `title` and `hiringOrganization`/`provider` name as the card title
- **Every** field about to be submitted as label/value rows — the complete payload, document references shown as their reference values. Nothing that isn't in the payload; nothing fabricated; nothing collapsed behind a "…and 12 more"
- A primary **Submit application** button (accent color tokens) wired to `sendPrompt('Submit the application exactly as shown')` — clicking it **is** the user's consent and triggers the Step 4 `nxis_action` call
- A secondary **Edit fields** affordance wired to `sendPrompt('Change the application details')`, styled with the outlined/secondary tokens

Use host design tokens (`var(--color-background-primary)` fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners). No hardcoded hex colors. **Do not call `nxis_action` until the user clicks Submit** (or affirms explicitly in text after seeing the full payload) — there is no auto-submit path in `TXN`, with or without prior consent.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Render the complete payload in prose or a plain list — every field and value — followed by a direct question ("Submit this application to Acme for Senior Engineer?") and wait for an affirmative reply before Step 4. A summary plus "shall I send it?" does not satisfy `TXN` review.

**Applying to several targets?** Each target is its own Step 2 → 3 → 4 pass with its own full-payload review — one review, one consent, one submission, per target. Never batch consents. For **regulated payload classes** (financial products, government services), multi-target submission in one conversation should be declined outright: three identical job applications is a feature; three identical mortgage applications is a problem.

### Step 4 — File the application with `nxis_action`

Call `nxis_action` with the action's `@id` and the reviewed `arguments`:

```json
{
  "method": "tools/call",
  "params": {
    "name": "nxis_action",
    "arguments": {
      "id": "https://careers.acme.example.com/jobs/8841/apply#action",
      "arguments": {
        "full_name": "Jane Doe",
        "email": "jane@example.com",
        "phone": "+1-313-555-0142",
        "resume_ref": "https://docs.example.com/r/jane-doe-2026",
        "work_authorization": "US citizen",
        "earliest_start": "2026-08-03"
      }
    }
  }
}
```

The MCP server fetches the action by `@id`, **validates** your arguments against its `PropertyValueSpecification`s, looks up the tenant's webhook binding, and POSTs the typed payload — **HMAC-signed** (`X-Nxis-Signature`) so the intake can verify origin. `TXN` submissions are **audit-logged** and **non-idempotent**: a dedupe token per (user, target `@id`) guards against accidental double-filing.

**On failure or timeout, stop.** Surface the error to the user exactly as it occurred and let them decide — **never auto-resubmit**. A timeout is not a "not filed": the intake may have received it, and the dedupe token is what prevents a second copy, not a retry loop. At launch the result is synchronous — `2xx` means the application was accepted into the intake; ATS-style "queued now, reference assigned later" flows surface the reference via a Phase-3 status callback, so a `2xx` without a reference is still a successful filing.

### Step 5 — Present the confirmation

Surface the filing as a confirmation card, not a bare line. Presentation branches on the host environment:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Call `visualize:read_me` with `["mockup"]` once, then `visualize:show_widget` with a single confirmation card:

- A success header (green check, success color tokens) — "Application submitted"
- Target `title` and `hiringOrganization`/`provider` name, plus the submission timestamp
- The **application reference** when the intake returned one, monospace and prominent; when none was returned, an honest "accepted — reference to follow from the organization" line, never an invented ID
- The `@id` hash (final path segment), monospace, in info color, above a dashed top-border separator

Use host design tokens (`var(--color-background-primary)` fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners). No hardcoded hex colors. If `nxis_action` returned an **error** result, render an error state using the danger tokens — never a success card for an application that didn't file, and never a retry without the user's explicit direction.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Append a single `<application-confirmation>` tag block at the very end of the response, containing the filing JSON — `target` (title + organization), `@type`, `actionStatus` (`CompletedActionStatus` / `FailedActionStatus`), the `application_reference` when returned, the submission time, and the source `@id` — passed through unmodified. Don't wrap the tag in a markdown code fence.

**Both paths.** Report only what `nxis_action` returned; never fabricate a reference or a "under review" status. After filing, retain nothing but the dedupe token and the action instance `@id` — the payload lives in the organization's intake, not with the agent.

## How `nxis_action` executes an application

One generic tool runs every server-side action; the application specifics live entirely in the discovered action's JSON-LD:

1. **Fetch** the action by `@id` (`getEntityByJsonLdId`).
2. **Validate** `arguments` against the action's `PropertyValueSpecification`s (required present, types).
3. **Resolve** the tenant binding for the action's `@type` and POST the typed payload to the real intake URL — never an agent-visible address — signed with the shared HMAC secret.
4. **Return** the filing result: `2xx` → `CompletedActionStatus` (with any application reference from the body), non-`2xx`/timeout → a tool error, surfaced without retry.

The agent never sees where the payload routes (binding is operational, not discovery); it only needs the action `@id` + inputs, both surfaced by `nxis_get`.

## Best practices

- **Full payload, fully shown.** The Step 3 review renders every field — a summary, a truncation, or a "trust me" never satisfies `TXN` review.
- **Per-field consent.** Only user-provided or user-approved values enter the payload; known-but-unoffered facts stay out.
- **Documents by reference.** `resume_ref`, `transcript_ref`, ID handles — never inline regulated content.
- **One target, one review, one submission.** Repeat the whole flow per target; never batch consents across applications.
- **Honor deadlines honestly.** If the record carries `applicationDeadline` and it has passed, say so before collecting anything.
- **Never resubmit on your own.** Failures and timeouts stop the flow and surface to the user; the dedupe token — not a retry — is the double-filing guard.
- **Use the most-specific target subtype** in discovery (`JobPosting`, not `Organization`).
- **Fall back to the record's own channel.** No `ApplyAction` → present the posting's application URL or contact card instead.

## Anti-patterns

- **Don't auto-submit, ever.** `TXN` has no consent-then-silent-submit path — every submission follows a full-payload review.
- **Don't pad the payload.** Fields the user didn't provide or approve don't ship, even when the value is known from context.
- **Don't inline regulated documents.** References only; decline raw IDs, financials, or records the spec doesn't call for.
- **Don't fan out.** No multi-target batches under one consent; decline multi-target entirely for financial and government applications.
- **Don't retry a failed or timed-out filing.** Surface it; the user decides. The intake may already hold the payload.
- **Don't fabricate a reference or status.** Report only what the intake returned.
- **Don't use this for inquiries, slots, or payments.** Inquiry → Quote Request Funnel; interview/appointment slot → Reservation Funnel; a fee at conversion is out of scope for this library.
- **Don't call `nxis_action` unauthenticated.** Write tools require an authenticated principal.

## Worked example

**User:** "Apply me to the Senior Engineer role at Acme."

1. **Discover** — `nxis_query` `JobPosting` filtered by organization and title → the posting; deadline is next Friday, still open.
2. **Read action** — `nxis_get` the posting → `potentialAction` is an `ApplyAction` (`@id` …`/apply#action`) with inputs `full_name`, `email`, `phone`, `resume_ref`, `work_authorization`, `earliest_start`.
3. **Collect & review** — the agent gathers each field conversationally (the user supplies a résumé link for `resume_ref`); a full-payload review widget shows all six fields verbatim with a **Submit application** CTA → user clicks Submit.
4. **File** — `nxis_action { id: ".../apply#action", arguments: { …all six reviewed fields… } }` → `2xx` with `{ "application_reference": "ACME-ENG-20260715-042" }`.
5. **Present** — "Application submitted ✓ · Acme, Senior Engineer · Ref ACME-ENG-20260715-042."

## Composing with other skills

- **Typed Retrieval** — hands off the entity `@id` of a discovered posting, program or listing; this skill owns the application conversion.
- **Quote Request Funnel** — the inquiry counterpart; route there when the user wants to *ask about* rather than *apply to* (a rental tour, an admissions question).
- **Reservation Funnel** — the slot counterpart; route there when the conversion is a time commitment (an interview slot, a gov-office appointment).

The application skill owns discovery-through-filed-application. The action `@id` is the execution contract; the entity `@id` is the discovery contract.
