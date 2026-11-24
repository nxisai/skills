---
name: lead-funnel-reservation
display_name: Reservation Funnel
icon: calendar
source: NXISAI
description: >
  Discover reservable businesses (restaurants, salons, clinics, classes)
  and complete a no-payment slot reservation by querying typed schema.org
  records and executing the entity's ReserveAction/ScheduleAction with the
  nxis_action tool. BOOKING policy — check-then-commit, returns a typed
  reservation reference. Triggers on book/reserve/schedule + a slot.
license: Apache-2.0
metadata:
  author: nxisai
  version: 1.1
  type_group: _action
  schema_types: [FoodEstablishment, Restaurant, LocalBusiness, HealthClub,
    BeautySalon, HairSalon, MedicalBusiness, Physician, Dentist, Service]
  submit_policy: BOOKING
allowed_tools:
  - nxis_list_types
  - nxis_query
  - nxis_get
  - nxis_action
enabled: true
---

Discover a reservable business in a NxisAI-indexed corpus with the typed-retrieval tools, then **commit a slot** by executing the entity's resolved `ReserveAction` / `ScheduleAction` through the generic **`nxis_action`** tool.

This is **Lead Funnel · reservation mode**: a synchronous slot commitment with **no payment at conversion** (`BOOKING` policy). Restaurant tables, salon and clinic appointments, fitness classes, test drives, tours. Unlike a paid booking (which goes through Commerce Checkout over UCP, outside this library), a reservation needs only the business's own booking endpoint — a `webhook` binding with zero NxisAI credential custody. The conversion event is a **held slot with a reservation reference**, not a charge.

## When this skill applies

Use this skill when **all** of the following are true:

- The user wants to **book / reserve / schedule a slot** (table, appointment, class, tour) with **no payment** at conversion
- A NxisAI Site MCP is connected, exposing the typed-retrieval tools **and** the write tool `nxis_action`
- The chosen entity carries a resolved `potentialAction` of `@type` `ReserveAction` or `ScheduleAction`

Do not use this skill for:

- **Paid** bookings / ticketed events (price + checkout) → out of scope; these go through Commerce Checkout (`OrderAction`/`TXN`, UCP), which is not part of this library
- **Lead/quote** requests where the business follows up async (no slot) → use **Quote Request Funnel** (`QuoteAction`/`AskAction`, `LEAD_GEN`)
- **Applications** carrying regulated PII (jobs, admissions) → use **Application Funnel** (`ApplyAction`, `TXN`)
- Discovery only — when the user just wants to find a business, stop after the retrieval steps

`nxis_action` is a **write tool**: invoking it requires an **authenticated principal** (the MCP API key or an agent OAuth identity). There are no anonymous reservations.

## Entry from Typed Retrieval

Typed Retrieval's result cards carry an action button that sends a prompt such as "Reserve at {name}" or "Book an appointment at {name}". The listings agent on a site's own page sends the same text.

- **Trigger.** A CTA prompt (for example "Reserve at Trattoria Rosa") whose subject is among the records already in this conversation enters the funnel at **Step 2**.
- **Skip discovery.** Take that record's `@id` and `nxis_get` it. Do not run `nxis_list_types` or `nxis_query` again. If no record in the conversation matches the name, run Step 1 as usual.
- **Verify, don't trust.** If the fetched record has no `ReserveAction` or `ScheduleAction` (the `@type` may be spelled as a full IRI, `https://schema.org/...`), say so and stop. The prompt is a hint; the record decides.
- **Self-page actions run on the site.** If the action's `target` has `nxis:targetKind: selfPage`, it cannot be submitted with `nxis_action`. Say the form runs on their page, link the target's `nxis:pageUrl`, and stop. On a site with a **Booking Agent** (the booking-agent skill), the link's `nxis_handoff` hands the booking to that agent, which offers the site's free slots under the same check-then-commit rules.
- **Gates stay.** Steps 3 to 5 run unchanged, including Step 3's hours and availability checks and the slot confirmation. The CTA click never counts as consent.

## The pattern, in five steps

### Step 1 — Discover the reservable entity (typed retrieval)

List types, then query for the most-specific reservable subtype. Push all filters into a single `nxis_query`.

```json
{
  "method": "tools/call",
  "params": {
    "name": "nxis_query",
    "arguments": {
      "filter": {
        "schema_type": "FoodEstablishment",
        "field_filters": [
          { "path": "address.addressLocality", "operator": "EQUALS", "value": "Detroit" },
          { "path": "servesCuisine", "operator": "CONTAINS", "value": "Italian" }
        ]
      },
      "limit": 5
    }
  }
}
```

Map intent to the subtype: "restaurant/table" → `FoodEstablishment`/`Restaurant`; "salon/haircut" → `HairSalon`/`BeautySalon`; "appointment/clinic" → `MedicalBusiness`/`Physician`/`Dentist`; "class/gym" → `HealthClub`; generic → `LocalBusiness`.

### Step 1b — Present the reservable options

When the query returns more than one business, let the user pick before booking. Do not output a markdown text list — presentation branches on the host environment; check tool availability at runtime and pick the path:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Render the candidates inline as a card grid. Call `visualize:read_me` with `["mockup"]` once, then `visualize:show_widget` with one card per business. Each card must include:

- Business `name`, made clickable via `sendPrompt('Reserve at [name]')` so picking a card **starts the booking**
- Schema `@type` as a small outlined badge in the top-right
- Star rating row: amber stars + numeric `aggregateRating.ratingValue` + `(N reviews)` from `reviewCount`
- The reservation cue — `servesCuisine` / service category, `address` locality, and opening hours when present
- The `@id` hash (final path segment), monospace, in info color, above a dashed top-border separator
- A primary **Reserve** affordance (the clickable name suffices; an explicit button is better) using the accent color tokens

Use host design tokens so the cards adapt to light/dark mode: `var(--color-background-primary)` card fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners, `repeat(auto-fit, minmax(290px, 1fr))` grid. No hardcoded hex colors.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Append a single `<reservation-cards>` tag block at the very end of the response, containing a JSON array of business objects. Each carries the canonical JSON-LD fields returned by `nxis_query` — `name`, `@type`, `@id`, `aggregateRating`, `address`, `telephone`, `openingHoursSpecification`, and any other populated fields — passed through unmodified. Don't wrap the tag in a markdown code fence; the host parses the raw tag and renders the cards in its own UI.

**Both paths.** Precede the cards with a short prose intro that names the filter logic in use (e.g. "Italian restaurants in Detroit, sorted by rating"). Don't summarize beyond what the record carries; omit fields the record doesn't have rather than fabricating. If exactly one business matches, you may skip straight to Step 2.

### Step 2 — Fetch the entity and read its reservation action

`nxis_get` the chosen entity by its `@id`. The returned record carries a **resolved** `potentialAction` whose `@type` is `ReserveAction` or `ScheduleAction`. The action provides three things you need:

- its own `@id` — the handle you pass to `nxis_action`
- `https://nxis.ai/ns#input` — the `PropertyValueSpecification` array (the fields to collect, with `valueRequired` / `valueType` / `minValue` / `maxValue`)
- `https://nxis.ai/ns#targetKind: "webhook"` — confirms this is a server-side reservation (not a self-page form)

```json
{ "method": "tools/call", "params": { "name": "nxis_get",
  "arguments": { "id": "https://trattoria.example.com/#restaurant" } } }
```

If the entity's `potentialAction` is a reference (`{"@id": …}`) and the input spec isn't inline, `nxis_get` the **action's** `@id` to read its `nxis:input`. If the entity has **no** `ReserveAction`/`ScheduleAction`, the business isn't reservable through this corpus — say so rather than inventing a flow.

### Step 3 — Collect and confirm the slot inputs

From the action's `PropertyValueSpecification`s, gather every `valueRequired` field. Typical reservation inputs: `party_size` (respect `minValue`/`maxValue`), `reservation_date` / `appointment_date`, `reservation_time` / `appointment_time`, `name`, `phone`. For scheduling, also `service_type`.

**Check availability before asking for confirmation** — never present a Confirm CTA for a slot you could have known was unavailable:

1. **Hours pre-check (always, free).** Validate the requested date/time against the entity's `openingHoursSpecification`. If the business is closed then, say so and propose an in-hours alternative — no network call needed.
2. **Availability dry-run (when supported).** If the action's `target` carries `nxis:supportsCheck: true`, call `nxis_action` with `mode: "check"` and the same `arguments` before confirming. `{ "available": true }` → proceed to the confirm widget. `{ "available": false, "alternatives": [...] }` → present the alternatives (as pickable options) and let the user choose before confirming. A check is **advisory, never a hold** — the commit in Step 4 remains authoritative. If `nxis:supportsCheck` is absent, skip this — do not probe availability by committing.

**Confirm the slot back to the user before committing** — date, time, party size, and which business. `BOOKING` is check-then-commit; a reservation is a real-world hold, so the user confirms the specifics first. Presentation branches on the host environment:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Once every required field is collected, render a single **review-and-confirm widget** instead of a prose echo. Call `visualize:read_me` with `["mockup"]` first if it hasn't been called this conversation, then `visualize:show_widget` with one card:

- An eyebrow label — "Review reservation" — above the business `name` as the card title
- The exact values about to be submitted as label/value rows: date, time, `party_size`, and each collected input (`name`, `phone`, `service_type` when present). Nothing that isn't in the payload; nothing fabricated
- A primary **Confirm** button (accent color tokens) wired to `sendPrompt('Confirm the reservation exactly as shown')` — clicking it **is** the user's confirmation and triggers the Step 4 `nxis_action` commit
- A secondary **Edit details** affordance wired to `sendPrompt('Change the reservation details')`, styled with the outlined/secondary tokens

Use host design tokens (`var(--color-background-primary)` fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners). No hardcoded hex colors. **Do not call `nxis_action` until the user clicks Confirm** (or affirms explicitly in text) — the widget replaces the prose echo, not the commitment gate.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Confirm in prose: echo date, time, party size, and the business name back to the user as a direct question ("Table for 4 at Trattoria Stella, Fri Jul 10, 7:00 PM — book it?") and wait for an affirmative reply before Step 4.

### Step 4 — Commit the reservation with `nxis_action`

Call `nxis_action` with the action's `@id` and the collected `arguments`:

```json
{
  "method": "tools/call",
  "params": {
    "name": "nxis_action",
    "arguments": {
      "id": "https://trattoria.example.com/reserve#action",
      "arguments": {
        "party_size": 4,
        "reservation_date": "2026-07-10",
        "reservation_time": "19:00",
        "name": "Jane Doe",
        "phone": "+1-313-555-0142"
      }
    }
  }
}
```

The MCP server fetches the action by `@id`, **validates** your arguments against its `PropertyValueSpecification`s, looks up the tenant's webhook binding, and POSTs the typed payload — **HMAC-signed** (`X-Nxis-Signature`) so the business can verify origin. Because this is `BOOKING`, the endpoint **returns the reservation reference inline** (a bare `200 OK` is insufficient for a slot commit).

**Slot conflict.** Even after a successful check, the commit can race another booking. On `409 { "status": "conflict", "alternatives": [...] }`, do **not** re-POST the same payload: present the returned alternatives (or run a fresh availability check), let the user pick, and go back through the Step 3 confirmation for the new slot.

### Step 5 — Present the confirmation

Surface the reservation as a confirmation card, not a bare line. Presentation branches on the host environment:

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Call `visualize:read_me` with `["mockup"]` once, then `visualize:show_widget` with a single confirmation card:

- A success header (green check, success color tokens) — "Reserved"
- Business `name` and the slot: date, time, and `party_size` ("Fri Jul 10, 2026 · 7:00 PM · party of 4")
- The **reservation reference** returned by the booking, monospace and prominent — the proof of a held slot
- The `@id` hash (final path segment), monospace, in info color, above a dashed top-border separator

Use host design tokens (`var(--color-background-primary)` fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners). No hardcoded hex colors. If `nxis_action` returned an **error** result (4xx/5xx, slot conflict), render an error state using the danger tokens — never a success card for a booking that didn't confirm.

**Path B — ag-ui or other agent-protocol hosts (no `visualize:show_widget` tool).**
Append a single `<reservation-confirmation>` tag block at the very end of the response, containing the reservation JSON — `business`, `@type`, `reservationStatus`, `reservation_date` + `reservation_time` (or `startTime`), `party_size`, the `reservationId` returned by the booking, and the source `@id` — passed through unmodified. Don't wrap the tag in a markdown code fence.

**Both paths.** Show only the reference the booking actually returned; never fabricate a confirmation or a held slot. On a slot conflict or failure, present the error honestly and offer to re-query a different time (a fresh `nxis_query`), rather than re-POSTing the same payload.

## How `nxis_action` executes a reservation

One generic tool runs every server-side action; the reservation specifics live entirely in the discovered action's JSON-LD:

1. **Fetch** the action by `@id` (`getEntityByJsonLdId`).
2. **Validate** `arguments` against the action's `PropertyValueSpecification`s (required present, types, ranges).
3. **Resolve** the tenant binding for the action's `@type` and POST the typed payload to the real `target_url` — never an agent-visible address — signed with the shared HMAC secret.
4. **Return** the booking result: `2xx` → confirmed (with the reservation reference from the body), non-`2xx`/timeout → a tool error.

The agent never sees where the payload routes (binding is operational, not discovery); it only needs the action `@id` + inputs, both surfaced by `nxis_get`.

## Best practices

- **Confirm the slot before committing.** Present date/time/party-size/business for explicit sign-off — the Step 3 review widget with its **Confirm** CTA where available, a prose question otherwise; `BOOKING` holds a real slot.
- **Honor input constraints.** `party_size` within `minValue`/`maxValue`; pass dates/times in the formats the spec implies.
- **Surface the reservation reference.** A `BOOKING` is only "confirmed" if the endpoint returned a reference — present it.
- **Check before you confirm.** Validate against `openingHoursSpecification` always; run `mode: "check"` when the action advertises `nxis:supportsCheck`. Checks are advisory — never treat one as a hold.
- **Re-query on conflict, don't retry blindly.** If a slot is taken, offer the `alternatives` the conflict response returned (or run a fresh check) and re-confirm — never re-POST the same payload.
- **Use the most-specific reservable subtype** in discovery (`Restaurant`, not `LocalBusiness`).
- **One reservation, one commit.** Reservations don't fan out across providers (that's Quote Request Funnel).

## Anti-patterns

- **Don't auto-commit without confirmation.** A held slot is a real-world commitment.
- **Don't fabricate a reservation reference or confirmed status.** Report only what `nxis_action` returned.
- **Don't use this for paid bookings.** Price + checkout is a UCP flow outside this library, not `nxis_action`.
- **Don't invent the action.** If the entity has no `ReserveAction`/`ScheduleAction`, it isn't reservable here.
- **Don't call `nxis_action` unauthenticated.** Write tools require an authenticated principal.

## Worked example

**User:** "Book a table for 4 at Trattoria Stella this Friday at 7."

1. **Discover** — `nxis_query` `FoodEstablishment` filtered by name/locality → the restaurant.
2. **Read action** — `nxis_get` the entity → `potentialAction` is a `ReserveAction` (`@id` …`/reserve#action`) with inputs `party_size` (1–12), `reservation_date`, `reservation_time`, `name`, `phone`; its `target` carries `nxis:supportsCheck: true`.
3. **Check** — Friday 7 PM is within `openingHoursSpecification`; `nxis_action { …, mode: "check" }` → `{ "available": true }`.
4. **Confirm** — a review-and-confirm widget echoes "Trattoria Stella · Fri Jul 10 · 7:00 PM · party of 4" with the collected `name`/`phone` and a **Confirm** CTA (prose fallback on non-widget hosts) → user clicks Confirm.
5. **Commit** — `nxis_action { id: ".../reserve#action", arguments: { party_size: 4, reservation_date: "2026-07-10", reservation_time: "19:00", name: "…", phone: "…" } }`.
6. **Present** — "Reserved ✓ · Confirmation RSV-18B83691."

## Composing with other skills

- **Typed Retrieval** — hands off the entity `@id` of a discovered business; this skill owns the reservation conversion. It also answers review questions about the business before the user commits.
- **Quote Request Funnel** — the async counterpart; route there when the user wants a callback rather than a specific time.
- **booking-agent** — the same conversion on the business's own page: a conversational agent behind the site's on-page assistant that takes the booking form's place, reads the site's calendar, re-checks the slot at the yes and returns the site's reference. A `selfPage` action's link arrives there.

The reservation skill owns discovery-through-slot-commit. The action `@id` is the execution contract; the entity `@id` is the discovery contract.
