---
name: typed-retrieval
display_name: Typed Retrieval
icon: 🧭
source: NXISAI
description: >
  General-purpose discovery over any NxisAI-indexed corpus: list the
  schema.org types a site exposes, query typed records with field filters,
  and fetch full entities by JSON-LD @id. Use for any find/search/look-up
  intent against a connected site's data.
license: Apache-2.0
metadata:
  author: nxisai
  version: 1.3
  type_group: _general
  schema_types: []
allowed_tools:
  - nxis_list_types
  - nxis_query
  - nxis_get
enabled: true
---

Discover anything in a NxisAI-indexed corpus with three typed-retrieval tools: **list** the schema.org types the site exposes, **query** the most specific type with intent-mapped filters, and **get** the full record by its JSON-LD `@id`.

This is the library's retrieval skill, and it covers every schema.org type. The type inventory comes from `nxis_list_types` at runtime, not from a type map built into the skill — so a product catalog, a job board, an unfamiliar corpus, a rare type and a cross-type question all follow the same pattern.

## When this skill applies

Use this skill when **all** of the following are true:

- The user wants to **find, search, browse, count, or look up** something in a connected site's data
- A NxisAI Site MCP is connected, exposing `nxis_list_types`, `nxis_query`, and `nxis_get`

Do not use this skill for:

- **Write intents** (quote, reserve, apply) — discovery here terminates at the `@id`; conversions route to the Lead Funnel skills
- **Purchases** — paid conversions go through Commerce Checkout over UCP, which is not part of this library
- Content that isn't in the corpus — never substitute web knowledge for a missing record
- **Answering a visitor's how-to or support question on the site's own pages** with a composed, cited answer → **support-agent**. It reads with the same three tools, and its answers are drawn as these cards

## The pattern, in four steps

### Step 1 — List available types

Never assume a type exists. List what this corpus actually exposes:

```json
{ "method": "tools/call", "params": { "name": "nxis_list_types", "arguments": {} } }
```

Map the user's natural-language intent to the **most specific** available subtype (`Plumber` over `LocalBusiness`, `BlogPosting` over `CreativeWork`). When several types could match, prefer the most specific one that appears in the list; when none matches, say so — do not force the nearest type.

### Step 2 — Query with intent-mapped filters

Push every constraint into a single `nxis_query` instead of over-fetching and filtering yourself:

```json
{
  "method": "tools/call",
  "params": {
    "name": "nxis_query",
    "arguments": {
      "filter": {
        "schema_type": "Product",
        "field_filters": [
          { "path": "offers.price", "operator": "LESS_THAN", "value": "100" },
          { "path": "brand.name", "operator": "EQUALS", "value": "Acme" }
        ]
      },
      "limit": 10
    }
  }
}
```

Filter paths are JSON-LD property paths on the type (`address.addressLocality`, `aggregateRating.ratingValue`, `offers.price`). Operators: `EQUALS`, `CONTAINS`, `LESS_THAN`, `GREATER_THAN`. Translate qualitative intent into typed filters ("cheap" → a price ceiling, "near downtown Detroit" → a locality equals-filter, "well-reviewed" → a rating floor).

### Step 3 — Retrieve full details

When the user picks a result — or the question needs fields the query summary didn't carry — fetch the entity by its `@id`:

```json
{ "method": "tools/call", "params": { "name": "nxis_get",
  "arguments": { "id": "https://example.com/products/widget#product" } } }
```

### Step 4 — Present results and their actions

Results render as an answer card, not a markdown list. A card carries an action button (CTA) only when its record has a `potentialAction` that a Lead Funnel skill can run; the button sends a prompt, and the funnel takes over from there. This skill never calls `nxis_action`. Presentation branches on the host; check tool availability at runtime:

**If the host has already drawn the cards**, skip both paths below. Signs of this:
- the tool result says so in its text ("Shows the results to the person as cards…", as the NxisAI Hub adds when the host draws its widget);
- the result carries a UI resource (`_meta.ui.resourceUri`).

Reply in prose only: one line on what was searched, and anything the cards don't show. Do not list or draw the results again; a second set duplicates the host's.

**Path A — Claude's chat interface (`visualize:show_widget` is available).**
Call `visualize:read_me` with `["mockup"]` once per conversation, then `visualize:show_widget` with one answer card:

- **Pick or list.** When the user asked for the best or a recommendation, open with one lead sentence and the pick, its reasons ticked, then up to 3 "Also good · tap to compare" rows. Otherwise show a plain list, each row opening to its facts and actions; "Show all N" past 4.
- **Draw each record as its archetype** (see *Card by archetype* below): it decides the title, the line under it, the facts and which button leads. Results of more than one archetype are listed together under the archetype's heading ("Businesses", "Reviews"), in the order the kinds first came.
- **Header.** Initials avatar, the title, the byline, then "★ `ratingValue` (`reviewCount`) · Open now · {access badge}", each part shown only when the record carries it. Open status comes from `openingHoursSpecification` only.
- **Lines.** Every reason ticked on the pick names a field the record holds. Other results show up to 3 facts, in this order: services, "In business since", one review quote; a review shows its own author and words instead.
- **Actions, at most three, the lead primary.** **Call {telephone}** as a `tel:` link; the **action CTA** from the map below, wired to `sendPrompt(<prompt>)`; **Their page**, linking to the record's `url` — that link is the card's citation. Which leads follows the archetype.
- **Compare** swaps the pick in place in the widget's own script. Only the CTA sends a prompt.
- Host tokens only: `var(--color-background-primary)` fill, `0.5px solid var(--color-border-tertiary)` border, `var(--border-radius-lg)` corners, the accent tokens for the primary button and the pick's outline. No hex colors.

**Path B — AG-UI or other agent-protocol hosts (no `visualize:show_widget` tool).**
Append one `<retrieval-cards>` tag block at the very end of the response, not inside a code fence. It holds a JSON array of the records exactly as `nxis_query` returned them, `potentialAction` included. Add nothing to the records; the host maps each action's `@type` to a CTA with the table below.

**Detail card.** After `nxis_get` (Step 3), render one detail card (Path A) or a `<retrieval-detail>` tag holding the one record (Path B). It shows the full record with the action CTA at the top: this is the likeliest moment to act, and `nxis_get` always returns the resolved `potentialAction` even when a query summary did not.

**Both paths.** Precede the cards with one prose line naming the filter logic ("Electricians in Royal Oak, sorted by rating"). Omit fields the record lacks. Do not `nxis_get` every result just to find its actions: if a query result has no `potentialAction`, show it without a CTA and let the detail card carry it.

#### Card by archetype

The NxisAI app and the on-page agent draw the same records the same way, from one renderer spec: [`references/renderer-spec.json`](references/renderer-spec.json), version 1. Draw the same card here. Resolve the record's most specific `@type` to an archetype:

- Look it up in the spec's `types` map, which covers 496 schema.org types. Each takes its nearest ancestor's archetype, so `Plumber` → `place` and `NewsArticle` → `readable`.
- If the record has several types, the archetype listed first in `archetypes` wins.
- Archetypes with `phase` above 1 (`happening` and `opportunity`) are not built yet, and neither are types the map lacks. Draw those as `thing`.

| Archetype | Heading | Title | Byline | Lead button |
|---|---|---|---|---|
| `place` (LocalBusiness, Place) | Businesses | `name` | type · `address.addressLocality` | **Call** |
| `profile` (Person, Organization) | People and organizations | `name` | `jobTitle`, else `worksFor` | the action CTA |
| `offerable` (Product, Service) | Products and services | `name` | `brand`, else `provider` | the action CTA |
| `opinion` (Review, Rating) | Reviews | "Review of {`itemReviewed.name`}" | none | **More about {it}** (sends "Tell me about {it}"); no Call and no Their page |
| `media` (MediaObject, so VideoObject and AudioObject; PodcastEpisode, Episode, Clip, Movie, MusicRecording) | Media | `name` | `partOfSeries.name`, else the type in words · "Episode {`episodeNumber`}"; then its length from `duration` | **Listen** (the `ListenAction` target) when it has one, else **Their page** |
| `series` (CreativeWorkSeries, PodcastSeries, Course, TVSeries) | Series and courses | `name` | kind ("Podcast", "Course") · `publisher`, else `author` · "{n} episodes" | **Listen to the latest** free part, else **Subscribe to listen**, else **Their page** |
| `readable` (Article, HowTo, Recipe, Book, CreativeWork) | Articles | `name`, else `headline` | `publisher` · `author` · `datePublished` date | **Read**, or **Read the preview** when paywalled, linking to `url` |
| `thing` (anything else) | Other | `name`, else the type in words | the type in words | the action CTA |

Further rules:

- A review's stars are its own `reviewRating`, shown without a count, since one review is not an aggregate.
- **Media and series.** A media item's Listen is worded by its access with the spec's `ListenAction` labels: **Listen to preview** for a free preview, and one button, **Subscribe to listen** (or **Sign up to listen** for a free sign-up), opening its `SubscribeAction` target when listening needs a subscription. A series lists its parts (`hasPart`) as rows of their own, with its badge said from them with `seriesAccess`, and each part's access with `partAccess`.
- A title falls back to the type in words ("Home and construction business"), never "Untitled" while the record holds a label.
- **Access badge.** Read it from markup sites already publish for Google:
  - an action's `actionAccessibilityRequirement`: `requiresSubscription` gives **Subscription**; `expectsAcceptanceOf` an Offer with a price gives that price;
  - `isAccessibleForFree: false` with a `hasPart` that is also not free gives **Free preview**;
  - `isAccessibleForFree: false` alone gives **Subscription**, and `true` gives **Free**;
  - otherwise the first `offers.price` (0 is **Free**).
- If a record says nothing about access, show no badge. Never write "Free" for it.

#### Action-to-CTA map

Choose the CTA by the action's `@type` alone. Records may spell it as a full IRI (`https://schema.org/QuoteAction`); treat that the same as `QuoteAction`, and read `target` and `nxis:targetKind` likewise under either spelling. Prompts name the business and carry no `@id`; the record is already in the conversation, and the funnel takes it from there.

| `potentialAction` `@type` | CTA label | Prompt the CTA sends | Hands off to |
|---|---|---|---|
| `QuoteAction` | Get a quote | Get a quote from {name} | Quote Request Funnel |
| `AskAction` | Contact | Contact {name} | Quote Request Funnel |
| `ReserveAction` | Reserve | Reserve at {name} | Reservation Funnel |
| `ScheduleAction` | Book an appointment | Book an appointment at {name} | Reservation Funnel |
| `ApplyAction` | Apply | Apply to {title} | Application Funnel |
| `BuyAction`, `OrderAction`, `PreOrderAction`, `DonateAction`, `PayAction` | none | none: **Their page** links to the record's `url` | none (Commerce Checkout is outside this library) |
| `RsvpAction`, `RegisterAction`, `DownloadAction` | none | none: **Their page** links to the record's `url` | none yet |
| `ViewAction`, `ReadAction`, `WatchAction`, `SearchAction`, `FindAction`, `InteractAction` | none | none | none |

Rules that go with the table:

- **Self-page actions hand off to the site's agent.** When the action's `target` has `nxis:targetKind: selfPage`, it runs only in a browser on the business's own page, not through `nxis_action`. Its CTA is the map's label plus where it happens (**Get a quote on their page**), linking to the target's `nxis:pageUrl`. When the target also carries `nxis:onPageAgent: true` (the site's pages run the NxisAI agent), add `nxis_handoff=<the action's @id>` to that link's query string, keeping the page's own query and fragment exactly as written: the site's agent opens on that form. Without the flag, link the page as it is; nothing there would read the parameter. With it, add `nxis_intent=` only with a few words of what the person wants ("a panel upgrade"), never a name, email, phone or address; URL-encode both. Without an `@id`, link the page as it is. It never sends a funnel prompt. Never label it a bare "Open their page": beside **Their page** (the record's `url`) the two read as duplicates that go to different places.
- **One action CTA per card.** If a record carries several runnable actions, take the one matching the user's words ("book" picks `ReserveAction`), else the first in the table's order.
- **No CTA without an action.** If the record has no `potentialAction`, or its type maps to none, the card shows no action button. Never invent one.
- **No fan-out CTA here.** "Request quotes from the top 3" stays in the Quote funnel's Step 1b, where its consent rules live.

## Best practices

- **List before you query.** The type inventory differs per site; `nxis_list_types` is one cheap call.
- **Most-specific subtype wins.** Specific types carry the domain fields your filters need.
- **One query, all filters.** Push constraints down; don't page through unfiltered results client-side.
- **Bounded limits.** Ask for what you'll show (5–10), page only on request.
- **Cite the `@id`.** Every claim about an entity should trace to a record the user can open.
- **Empty is an answer.** Zero results means say so and loosen one filter at a time — visibly, not silently.

## Anti-patterns

- **Don't guess types.** Querying a type the corpus doesn't expose wastes a call and invites forcing.
- **Don't fabricate fields.** If the record lacks a rating, there is no rating.
- **Don't blend corpus data with web knowledge** without labeling which is which.
- **Don't execute actions.** A record's `potentialAction` marks where a Lead Funnel skill takes over — don't call write tools from here. A CTA starts the funnel; it is not the user's consent to submit.
- **Don't draw over the host's cards.** When a tool result carries a UI resource, the host already rendered it.

## Worked examples

**User:** "What kinds of things does this site have, and do they list any events under $20?"

1. **List** — `nxis_list_types` → `["Event", "MusicEvent", "Organization", "Person", "BlogPosting"]`; report the inventory.
2. **Query** — `nxis_query` on `MusicEvent` (most specific) with `offers.price LESS_THAN 20`, limit 10 → two matches.
3. **Present** — both events as cards with date, venue and price. Each record carries a `BuyAction`, which maps to no CTA: buying a ticket is a paid conversion this library does not handle, so each card links **Their page** to the event's `url`.

**User:** "Who's the best-rated electrician here?"

1. **List** — `Electrician` is in the inventory.
2. **Query** — `nxis_query` on `Electrician`, sorted by `aggregateRating.ratingValue` descending, limit 5.
3. **Present** — "Electricians, sorted by rating", then the pick, McManus Electric (★ 4.9, 167 reviews), with up to three compare rows. Its `potentialAction` is a `QuoteAction` (spelled `https://schema.org/QuoteAction` in the record):
   - With a server-side target (`webhook`, `gateway`), the buttons are **Call (248) 555-1971**, **Get a quote** (sends "Get a quote from McManus Electric"), **Their page**. The click hands off to the Quote Request Funnel, which still runs its own review step.
   - With `nxis:targetKind: selfPage`, the quote form runs on the business's page, so the CTA is **Get a quote on their page**, linking to the target's `nxis:pageUrl`, plus `?nxis_handoff=<the action's @id>` when the target says `nxis:onPageAgent: true`, so the site's agent opens on the form.

## Composing with other skills

- **Site Onboarding** and **MCP Discovery Publishing** — upstream. They put the server this skill queries in place and make it findable.
- **Lead Funnel skills** (Quote, Reservation, Application) — the CTA prompt is the handoff. It names the business; the funnel finds the record and its `@id` in the conversation and skips its own discovery.
- **Support Agent** — on a site's own pages, answers "how do I…" from the same records, and sends the records it cites as cards this skill's card rules draw (`readable`, `media`, `profile`).

This skill owns discovery. The entity `@id` is the contract every downstream skill consumes.
