/**
 * example-site.ts — a `SupportSite` for one business, and for a directory.
 *
 * EXAMPLE values throughout: Ridgeline Air, a fictional purifier maker whose
 * help site is the fixture in fixtures/ridgeline-records.json. Replace the
 * names, origins, emergency words and contact with the site's own, and keep
 * the shape.
 *
 * One business: `providerAt` returns it for every page, `match` returns [],
 * and `scopeOf` returns 'site' for every record, so nothing is ever out of
 * scope. A directory: `providerAt` reads the business from the page,
 * `match` finds the businesses a visitor names, and `scopeOf` says which
 * business a record belongs to, so one answer never mixes two.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  gapSinkFromEnv,
  mcpRecords,
  type GapLookup,
  type GapSink,
  type HandoffPage,
  type JsonLd,
  type ProductName,
  type Provider,
  type RecordRow,
  type StoredGapQuestion,
  type SupportRecords,
  type SupportSite,
  type TurnRecord,
  type TurnStore,
} from './support-core';

/** Products a question may name, from a filter-only query (free), cached for an hour. */
export function productNamesFrom(records: SupportRecords, aliases: (name: string) => string[] = defaultAliases, ttlMs = 60 * 60_000): () => Promise<ProductName[]> {
  let cached: { at: number; names: ProductName[] } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.names;
    const rows = await records.query({ filter: { schema_type: 'Product' }, limit: 100 });
    const byName = new Map<string, ProductName>();
    for (const r of rows) {
      const name = typeof r.name === 'string' ? r.name : '';
      if (name && !byName.has(name)) byName.set(name, { name, aliases: aliases(name) });
    }
    // Rows can be ids only: fetch names for up to 20 (free reads) when the query gave none.
    if (!byName.size) {
      for (const r of rows.slice(0, 20)) {
        const rec = await records.get(r['@id']).catch(() => null);
        const name = typeof rec?.name === 'string' ? rec.name : '';
        if (name && !byName.has(name)) byName.set(name, { name, aliases: aliases(name) });
      }
    }
    cached = { at: Date.now(), names: [...byName.values()] };
    return cached.names;
  };
}

/**
 * The site's contact page, from its records: the first ContactPage's url (or its @id), or null when there is none.
 * A filter-only query, so no embedding charge; kept for `ttlMs`, and a failed read is not kept.
 */
export function contactPageFrom(records: SupportRecords, ttlMs = 60 * 60_000): () => Promise<string | null> {
  let cached: { at: number; url: string | null } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.url;
    const rows = await records.query({ filter: { schema_type: 'ContactPage' }, limit: 5 });
    const row = rows.find((r) => typeof r.url === 'string' || typeof r['@id'] === 'string');
    const url = row ? (typeof row.url === 'string' && row.url) || String(row['@id']).split('#')[0] || null : null;
    cached = { at: Date.now(), url };
    return url;
  };
}

/** EXAMPLE: "Ridgeline X200 Pro" is also said "X200 Pro". */
const defaultAliases = (name: string) => {
  const bare = name.replace(/^Ridgeline\s+/i, '');
  return bare !== name ? [bare] : [];
};

const ORIGIN = 'https://fixture.example';

export interface ExampleOptions {
  /** The site's read tools. Default: its MCP server at SUPPORT_MCP_ENDPOINT, fixed server-side. */
  records?: SupportRecords;
  sensitive?: boolean;
  /** Whether the relay lists a person target (`team`). */
  person?: boolean;
  /** Where gap reports go. Default: `nxis_report_content_gap` with SUPPORT_GAP_KEY at SUPPORT_PROVISIONING_ENDPOINT, both server-side. */
  gaps?: GapSink | null;
  /** False when the owner declined the gap list at install (SKILL.md step 3). */
  gapReports?: boolean;
  /** Where the questions and turns a report names are kept. Default: `turnStoreFromEnv(process.env)`, a file for development. */
  turns?: TurnStore | null;
  /** The key question keys and turn references are made with. Default: SUPPORT_TURN_REF_SECRET. Without it and `turns`, no gap reports. */
  turnRefSecret?: string;
}

// ── The questions and turns a report names: kept here, never sent ───────────

/** Where `turnStoreFromEnv` keeps questions and turns when SUPPORT_TURN_STORE isn't set, under the working directory. */
export const DEFAULT_TURN_STORE = '.support/turns.jsonl';

/** A turn as the file holds it: one JSON object per line. */
export type StoredTurn = TurnRecord & { ref: string };

/** A gap question's wording as the file holds it: one line each time the question is reported. */
export type StoredQuestionLine = { key: string; question: string; at: string };

/**
 * A TurnStore that appends to a JSON Lines file, readable by its owner only: a `{ref, …}` line for
 * each reported turn, and a `{key, question, at}` line each time a gap's question is reported. For
 * development: a real site keeps these in its own database, with its own retention policy, and
 * deletes them when it deletes the visitor's other data.
 */
export function fileTurns(path: string): TurnStore {
  const file = resolve(path);
  let ready: Promise<void> | null = null;
  const prepare = async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // The default folder is ours: keep visitors' words out of git.
    if (path === DEFAULT_TURN_STORE) await writeFile(resolve(dirname(file), '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
  };
  return {
    async save(ref, turn) {
      await (ready ??= prepare().catch((err) => ((ready = null), Promise.reject(err))));
      await appendFile(file, `${JSON.stringify({ ref, ...turn } satisfies StoredTurn)}\n`, { mode: 0o600 });
    },
    async saveQuestion(key, q) {
      await (ready ??= prepare().catch((err) => ((ready = null), Promise.reject(err))));
      await appendFile(file, `${JSON.stringify({ key, question: q.question, at: q.at } satisfies StoredQuestionLine)}\n`, { mode: 0o600 });
    },
  };
}

/** The turn a gap's ref names, from a `fileTurns` file: the latest saved with that ref, or null. */
export async function findTurn(path: string, ref: string): Promise<StoredTurn | null> {
  const text = await readFile(resolve(path), 'utf8').catch((err) => (err?.code === 'ENOENT' ? '' : Promise.reject(err)));
  let found: StoredTurn | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes(ref)) continue;
    try {
      const t = JSON.parse(line) as StoredTurn;
      if (t.ref === ref) found = t;
    } catch {
      // A line cut short by a crash: skip it.
    }
  }
  return found;
}

/**
 * The wording a gap's `question_key` names, from a `fileTurns` file, with when it was first and last
 * reported; null when the file has none under that key.
 */
export async function findGapQuestion(path: string, key: string): Promise<StoredGapQuestion | null> {
  const text = await readFile(resolve(path), 'utf8').catch((err) => (err?.code === 'ENOENT' ? '' : Promise.reject(err)));
  let question = '';
  let first = '';
  let last = '';
  for (const line of text.split('\n')) {
    if (!line.includes(key)) continue;
    try {
      const q = JSON.parse(line) as Partial<StoredQuestionLine>;
      if (q.key !== key || typeof q.question !== 'string' || typeof q.at !== 'string') continue;
      question = q.question;
      if (!first || q.at < first) first = q.at;
      if (!last || q.at > last) last = q.at;
    } catch {
      // A line cut short by a crash: skip it.
    }
  }
  return first ? { key, question, firstSeen: first, lastSeen: last } : null;
}

/**
 * The file store as `gapsWithWording` reads it:
 * `gapsWithWording(gaps, fileGapLookup(path))` gives each gap from `nxis_list_content_gaps` its
 * question's wording and the turns behind its refs.
 */
export const fileGapLookup = (path: string): GapLookup => ({
  question: (key) => findGapQuestion(path, key),
  turn: (ref) => findTurn(path, ref),
});

/**
 * Question keys and turn references from the host's secrets: SUPPORT_TURN_REF_SECRET (at least 32 characters: `openssl
 * rand -hex 32`), and SUPPORT_TURN_STORE, the file questions and turns go in (default
 * `.support/turns.jsonl`). Both server-side, never VITE_-prefixed. Without the secret: no store, no
 * key to name a question by, and so no gap or close reports (👍 counts still go).
 */
export function turnStoreFromEnv(env: { SUPPORT_TURN_STORE?: string; SUPPORT_TURN_REF_SECRET?: string }): { turns: TurnStore; turnRefSecret: string } | { turns: null; turnRefSecret?: undefined } {
  const secret = env.SUPPORT_TURN_REF_SECRET?.trim();
  if (!secret) return { turns: null };
  if (secret.length < 32) {
    console.error('[support] SUPPORT_TURN_REF_SECRET is shorter than 32 characters: question keys and turn references are off, so no gap reports are sent.');
    return { turns: null };
  }
  return { turns: fileTurns(env.SUPPORT_TURN_STORE?.trim() || DEFAULT_TURN_STORE), turnRefSecret: secret };
}

/** EXAMPLE: Ridgeline Air, one business. */
export function exampleSite(o: ExampleOptions = {}): SupportSite {
  const records = o.records ?? mcpRecords({ endpoint: process.env.SUPPORT_MCP_ENDPOINT ?? `${ORIGIN}/mcp` });
  const ridgeline: Provider = { id: 'ridgeline-air', name: 'Ridgeline Air' };
  return {
    agentName: 'Ridgeline Help',
    role: "answers questions from Ridgeline Air's help content",
    siteName: 'Ridgeline Air',
    records,
    contentLanguage: 'en',
    allowedLinkOrigins: [ORIGIN, 'https://www.youtube.com'],
    productNames: productNamesFrom(records),
    providerAt: () => ridgeline,
    match: () => [],
    scopeOf: () => 'site',
    emergency: {
      // EXAMPLE: what the business would want handled as a phone call, never a help article.
      pattern: /\b(smoke|smoking|on fire|flames?|sparks?|sparking|electric shock|burning smell|melting)\b/,
      advice: "Switch the purifier off at the wall and unplug it now. Don't use it again. If there's smoke or fire, call 999. Then contact Ridgeline on 0161 496 0000 for a replacement.",
    },
    advice: /\b(asthma|allerg\w*|symptoms?|medical|doctor|health condition|lungs?)\b/i,
    sensitive: o.sensitive ?? false,
    person: o.person ?? true,
    contactFallback: `our contact page, ${ORIGIN}/contact`,
    contactPage: contactPageFrom(records),
    // EXAMPLE: the owner said yes to the gap list. Set false if they declined: the thumbs still show and reply.
    gapReports: o.gapReports ?? true,
    gaps: o.gaps === undefined ? gapSinkFromEnv(process.env) : o.gaps,
    // The wording of each question a gap report names, and the prompt and reply of each turn, stay here,
    // under the key and the ref the report carries. Without them, no gap or close report is sent.
    ...(o.turns === undefined && o.turnRefSecret === undefined ? turnStoreFromEnv(process.env) : { turns: o.turns ?? null, turnRefSecret: o.turnRefSecret }),
    // EXAMPLE: the team's names, never kept in a gap's question, on the host or anywhere.
    gapNames: ['Dana Okafor', 'Sam Whitfield'],
  };
}

// ── A directory ─────────────────────────────────────────────────────────────

/** One business a directory lists, and where its pages are. */
export interface Business extends Provider {
  /** Its pages' path prefix: '/biz/northside/'. A record under it is the business's. */
  path: string;
  /** Its JSON-LD `@id`, when records link to it (publisher, provider, about, isPartOf). Gap reports name it as `provider`. */
  entity?: string;
  /** Words that name it and no other business: 'northside'. */
  words?: string[];
}

/** A link from a record to a business: `publisher`, `provider`, `about` or `isPartOf` giving its `@id`. */
const linked = (r: JsonLd | RecordRow): string[] =>
  ['publisher', 'provider', 'about', 'isPartOf']
    .flatMap((k) => (Array.isArray((r as JsonLd)[k]) ? ((r as JsonLd)[k] as unknown[]) : [(r as JsonLd)[k]]))
    .map((v) => (v && typeof v === 'object' ? String((v as Record<string, unknown>)['@id'] ?? '') : ''))
    .filter(Boolean);

/** EXAMPLE: a directory of purifier dealers, with the directory's own help at /help/. */
export function directorySite(businesses: Business[], o: ExampleOptions = {}): SupportSite {
  const site = exampleSite(o);
  const pathOf = (u: string) => {
    try {
      return new URL(u).pathname;
    } catch {
      return '';
    }
  };
  const byPath = (u: string | undefined) => (u ? businesses.find((b) => pathOf(u).startsWith(b.path)) : undefined);
  return {
    ...site,
    agentName: 'Purifier Directory Help',
    role: 'answers questions from the help content of the directory and the dealers it lists',
    siteName: 'the Purifier Directory',
    directory: true,
    providerAt: (page: HandoffPage | undefined) => businesses.find((b) => b.entity && b.entity === page?.entity) ?? byPath(page?.url) ?? null,
    match(text) {
      const t = ` ${text.toLowerCase()} `;
      const whole = businesses.filter((b) => t.includes(b.name.toLowerCase()));
      if (whole.length) return whole;
      return businesses.filter((b) => (b.words ?? []).some((w) => new RegExp(`\\b${w}\\b`, 'i').test(t)));
    },
    // In order: a link to the business, the record's url under its pages, else the directory's own.
    scopeOf(r) {
      const link = linked(r).map((id) => businesses.find((b) => b.entity === id)).find(Boolean);
      if (link) return link.id;
      const owner = byPath(typeof r.url === 'string' ? r.url : undefined) ?? byPath(String(r['@id']));
      return owner?.id ?? 'site';
    },
  };
}
