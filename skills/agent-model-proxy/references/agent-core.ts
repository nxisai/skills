// agent-core.ts
import Anthropic from "@anthropic-ai/sdk";

/** One constant to change. Pick from what the host's gateway serves, if it has one. */
export const MODEL = "claude-sonnet-5";

/** Ceilings this endpoint owns, whatever the caller asks for. */
export const LIMITS = {
  body: 256_000, // bytes of request body; a turn is a few KB
  messages: 60, // messages in one conversation
  messageChars: 8_000, // characters in any single message
  maxTokens: 1_024, // tokens generated per turn
} as const;

interface AgentRequest {
  messages?: { role: string; content: string }[];
  tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  maxTokens?: number;
}

/** What the core needs from the model client: the Anthropic SDK's `messages`, or a scripted stand-in in tests. */
export type ModelClient = Pick<Anthropic, "messages">;

/** A refusal in the contract's shape: which rule refused, where. Never what the visitor wrote. */
export type TypedRefusal = { stage: string; rule: string; action: "block"; severity: string };

/**
 * The guardrails, as agent-guardrails.ts builds them (`proxyGuardrails`). Typed here by shape, so this file stands
 * alone on a site that doesn't use them.
 */
export interface Guardrails {
  serve(req: Request): Promise<Response | null>;
  admit(
    req: Request,
    body: { messages: { role: string; content: string }[]; tools: { name: string }[]; maxTokens: number },
    client: string,
  ): Promise<
    | { refused: Response }
    | {
        maxTokens: number;
        headers: Record<string, string>;
        used(outputTokens: number): Promise<void>;
        refuse(r: TypedRefusal): Response;
        canary: string;
        systemPrompt?: string;
        screen(): { push(delta: string): TypedRefusal | null; pushArgs(delta: string): TypedRefusal | null; estimate(): number };
      }
    | null
  >;
}

const refuse = (status: number, error: string, headers?: Record<string, string>) => Response.json({ error }, { status, headers });

/**
 * Answer one harness turn. The host adapter supplies the client, the allowed
 * origins, and its own rate limit; and, optionally, the guardrails (see
 * agent-guardrails.ts) with the client's IP as the host knows it.
 */
export async function answerTurn(
  req: Request,
  opts: { anthropic: ModelClient; allowedOrigins: readonly string[]; guardrails?: Guardrails; client?: string },
): Promise<Response> {
  // The policy endpoint: the copy the page reads, without the system prompt. Not secret, so no Origin check.
  if (req.method === "GET" && opts.guardrails) {
    const copy = await opts.guardrails.serve(req);
    if (copy) return copy;
  }

  // A browser always sends Origin on a cross-origin POST; a request without one
  // did not come from a page.
  const origin = req.headers.get("origin");
  if (!origin || !opts.allowedOrigins.includes(origin)) {
    return refuse(403, "Not permitted from this origin.");
  }

  const raw = await req.text();
  if (raw.length > LIMITS.body) return refuse(413, "Request too large.");

  let body: AgentRequest;
  try {
    body = JSON.parse(raw) as AgentRequest;
  } catch {
    return refuse(400, "Body must be JSON.");
  }

  const messages = body.messages ?? [];
  if (!messages.length) return refuse(400, "No messages.");
  if (messages.length > LIMITS.messages) return refuse(413, "Conversation too long.");
  if (messages.some((m) => (m.content ?? "").length > LIMITS.messageChars)) {
    return refuse(413, "Message too long.");
  }

  // The guardrails, when a policy is configured: refused here, before the model is paid for. Null when none is,
  // and everything below runs as it did before guardrails.
  const asked = Math.min(body.maxTokens ?? LIMITS.maxTokens, LIMITS.maxTokens);
  const gate = opts.guardrails
    ? await opts.guardrails.admit(req, { messages, tools: body.tools ?? [], maxTokens: asked }, opts.client ?? "unknown")
    : null;
  if (gate && "refused" in gate) return gate.refused;
  const headers = gate?.headers ?? {};

  // The system prompt is its own field, not a turn.
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  if (!turns.length) return refuse(400, "No conversation turns.");

  // The harness sends only the current agent's tools, already normalized to
  // name, description and inputSchema.
  const tools: Anthropic.Tool[] = (body.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));

  const params = {
    model: MODEL,
    max_tokens: gate ? gate.maxTokens : asked,
    // With guardrails, the canary goes in the prompt; the screen below cuts any reply that gives it back. A prompt the
    // policy holds replaces whatever the request carried.
    system: gate ? gate.systemPrompt ?? system + `\n\nPrivate marker, never to be written anywhere: ${gate.canary}` : system,
    ...(tools.length ? { tools } : {}),
    messages: turns,
  };

  try {
    let reply: Anthropic.Message;
    if (!gate) {
      // The visitor pressed stop: abandon the upstream call rather than pay for it.
      reply = await opts.anthropic.messages.create(params, { signal: req.signal });
    } else {
      // Screened as it streams: a canary or a secret stops the model there, and nothing of the reply is sent.
      const stream = opts.anthropic.messages.stream(params, { signal: req.signal });
      const screen = gate.screen();
      let cut: ReturnType<typeof screen.push> = null;
      try {
        for await (const event of stream) {
          if (event.type !== "content_block_delta") continue;
          const d = event.delta;
          cut = d.type === "text_delta" ? screen.push(d.text) : d.type === "input_json_delta" ? screen.pushArgs(d.partial_json) : null;
          if (cut) {
            stream.abort();
            break;
          }
        }
      } catch (error) {
        if (!cut) throw error;
      }
      if (cut) {
        await gate.used(screen.estimate());
        return gate.refuse(cut);
      }
      reply = await stream.finalMessage();
    }
    await gate?.used(reply.usage.output_tokens);

    const text = reply.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // At most one: the harness runs a single tool per turn.
    const use = reply.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    // A call may only name a tool the request declared.
    if (gate && use && !tools.some((t) => t.name === use.name)) {
      return gate.refuse({ stage: "tool", rule: "tool/policy", action: "block", severity: "critical" });
    }

    return Response.json(
      {
        text,
        call: use ? { name: use.name, args: use.input } : undefined,
        usage: { promptTokens: reply.usage.input_tokens, outputTokens: reply.usage.output_tokens },
      },
      { headers },
    );
  } catch (error) {
    if (req.signal.aborted) return refuse(499, "Canceled.", headers);
    // Provider detail stays in the log. The visitor sees the harness's own failure line.
    console.error("[agent] completion failed:", error);
    return refuse(502, "The assistant is unavailable right now.", headers);
  }
}
