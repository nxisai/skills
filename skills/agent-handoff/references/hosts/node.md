# Node (Express, a Vite dev server, any Node server)

**Status: draft.** Used for the listings demo, a Vite site whose server code runs as Vite plugins behind a tunnel. The answers below are what that project does; the production answers (records and rate limits on a real Node deployment) are unconfirmed and depend on where it runs.

Detect: a Node server in the project (`server.ts`, an Express app), or server-side Vite plugins (`configureServer`) and no host config.

## 1. Where server code lives, and what it runs on locally

Beside the rest of the server code: an Express router, or a Vite plugin's `configureServer` middleware. The core speaks web `Request`/`Response`, so the adapter converts Node's request into one and writes the `Response` back — streaming the body, so server-sent events reach the browser as they come:

```ts
// plugins/handoff.ts — a Vite plugin; the same body works as Express middleware
import type { Plugin } from "vite";
import { Readable } from "node:stream";
import { handleHandoff, handlePush, type RelayOptions } from "./handoff-core";

export function handoffPlugin(opts: RelayOptions): Plugin {
  return {
    name: "handoff-relay",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const push = url.pathname === "/api/handoff-push";
        if (!push && url.pathname !== "/api/handoff" && !url.pathname.startsWith("/api/handoff/")) return next();
        const request = new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === "GET" ? undefined : (Readable.toWeb(req) as ReadableStream),
          duplex: "half",
        } as RequestInit);
        const rest = url.pathname.replace(/^\/api\/handoff\/?/, "");
        const response = push ? await handlePush(request, opts) : await handleHandoff(request, rest, opts);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) return res.end();
        Readable.fromWeb(response.body as never).pipe(res);
      });
    },
  };
}
```

A tunnel in front makes the public origin the one the browser sends: list it in `allowedOrigins` beside `http://localhost:<port>`.

## 2. Where records live

One process: a JSON file per record under a git-ignored directory (`.data/handoff/`), or a Map if losing records on restart is acceptable. **More than one process** (a cluster, several containers): a shared store — Redis, a database table — or the key check fails whenever a visitor's requests land on different processes. Unconfirmed: pick with the user.

## 3. Where secrets live

The process environment, loaded from a git-ignored `.env` in development (Vite's `loadEnv(mode, cwd, "")` reads unprefixed variables for plugins without exposing them to the page). Never a `VITE_`-prefixed variable: those are compiled into the page.

## 4. The rate-limit primitive, and how it is proved

No host primitive. Use the platform's in front of the server (a CDN or load balancer rule), or middleware (`express-rate-limit`) — which runs in the process, so a refused request still costs a little. A dev server behind a tunnel has none; say so to the user. Prove it as SKILL.md step 7 says.

## 5. How long one response may stream

As long as the connection holds: no function time limit. A tunnel or proxy in front may cut long idle streams; the harness resumes them.
