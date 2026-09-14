import type { NextRequest } from "next/server";
import {
  assertLiteLLMConfigured,
  startChatStream,
  type ChatMessage,
} from "@/lib/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The full baseline in the first (uncached) turn can easily exceed
// Vercel's 60s Hobby-plan default. 300s is the Pro-plan ceiling.
export const maxDuration = 300;

// If LiteLLM hasn't produced a single text delta in this many ms,
// assume the stream is hung and surface an error to the client.
const FIRST_TOKEN_STALL_MS = 20_000;

type Body = {
  messages?: ChatMessage[];
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: "messages[] is required and must be non-empty" },
      { status: 400 },
    );
  }

  if (messages.at(-1)?.role !== "user") {
    return Response.json(
      { error: "The final message must have role 'user'" },
      { status: 400 },
    );
  }

  try {
    assertLiteLLMConfigured();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }

  const encoder = new TextEncoder();

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      let sentAnyDelta = false;
      const abortController = new AbortController();
      let stallTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        abortController.abort(
          new Error(
            `No first token from litellm within ${FIRST_TOKEN_STALL_MS}ms`,
          ),
        );
      }, FIRST_TOKEN_STALL_MS);
      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      try {
        const stream = startChatStream(messages, abortController.signal);
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            if (!sentAnyDelta) clearStallTimer();
            sentAnyDelta = true;
            send({ type: "delta", text: event.delta.text });
          }
        }
        clearStallTimer();

        try {
          const final = await stream.finalMessage();
          send({
            type: "done",
            provider: "litellm",
            usage: {
              input_tokens: final.usage.input_tokens,
              output_tokens: final.usage.output_tokens,
              cache_creation_input_tokens:
                final.usage.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens:
                final.usage.cache_read_input_tokens ?? 0,
            },
          });
        } catch (finalErr) {
          const finalMsg =
            finalErr instanceof Error ? finalErr.message : "Unknown error";
          console.error(`[chat] litellm finalMessage() failed: ${finalMsg}`);
          send({
            type: "done",
            provider: "litellm",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          });
        }
      } catch (err) {
        clearStallTimer();
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[chat] litellm failed: ${message}`);
        send({ type: "error", provider: "litellm", error: message });
      }

      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
