# Changelog

Notable changes to the skills. Only the latest commit on `main` is supported; reinstall the skills to pick up a change.

## 2026-11-28

### Changed: agent-model-proxy applies guardrails by default

**This changes behavior for proxies installed before this date.**

- A proxy with no guardrails policy now enforces the harness's built-in defaults. Before, it enforced nothing.
  - input length: 4,000 characters in the newest message
  - send rate: 10 a minute per conversation and 50 per IP and origin, or 10 per IP and origin without a conversation secret
  - per turn: 8 generations and 16,000 output tokens
  - per conversation: 200 generations and 200,000 output tokens
  - a reply that calls a tool the request didn't declare is refused
  - replies are always screened for the canary and for secrets
- A page configured more loosely than these defaults, for example with a longer input limit, now meets them at the proxy. To keep a looser limit, configure a guardrails policy that sets it.
- Turning guardrails off is now explicit: `answerTurn(req, { guardrails: false })`. The opt-out logs a warning once per instance, and every response carries `Nxis-Guardrails: off`. Leaving the option out is now a type error.
- The Netlify, Vercel and Cloudflare host profiles build the guardrails by default.

### Security: quote-agent screens the visitor's message

- The Quote Agent screens what the visitor types for instructions to the agent before any model call, in English, Spanish, French, German, and Base64 of each, as the Booking Agent does.
- A screened message gets a fixed reply and the pending question. It never counts as a yes, and it's withheld on later turns.
- The visitor's words and the handoff envelope reach the model in delimited blocks, with delimiter-like text defused.
