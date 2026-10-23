import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only pairing HTTP goes through Next; Caddy routes /agent/ws directly to the relay. */
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (!["pairings", "approve", "revoke"].includes(action))
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Unknown agent route." } },
      { status: 404 },
    );
  const backend = process.env.AGENT_RELAY_INTERNAL_URL;
  if (!backend)
    return NextResponse.json(
      {
        error: {
          code: "RELAY_UNAVAILABLE",
          message: "This website has not enabled the agent relay.",
        },
      },
      { status: 503 },
    );
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return NextResponse.json(
          { error: { code: "TOO_LARGE", message: "Pairing request is too large." } },
          { status: 413 },
        );
      }
      chunks.push(part.value);
    }
  }
  const headers = new Headers({
    "Content-Type": request.headers.get("content-type") ?? "application/json",
  });
  for (const name of ["origin", "authorization"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (process.env.AGENT_RELAY_PROXY_TOKEN) {
    headers.set("x-agent-proxy-token", process.env.AGENT_RELAY_PROXY_TOKEN);
    headers.set("x-agent-client-ip", request.headers.get("x-client-ip") ?? "proxy");
  }
  try {
    const response = await fetch(new URL(`/api/agent/${action}`, backend), {
      method: "POST",
      headers,
      body: Buffer.concat(chunks),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "RELAY_UNAVAILABLE", message: "The agent relay is unavailable." } },
      { status: 503 },
    );
  }
}
