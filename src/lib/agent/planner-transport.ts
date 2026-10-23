import { request as httpsRequest } from "node:https";
import { Readable, type Transform } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { httpWarning, type ConnectionWarning } from "./connection-security";

const CERTIFICATE_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "INVALID_CA",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
]);
const DECODERS = new Map<string, () => Transform>([
  ["gzip", createGunzip],
  ["deflate", createInflate],
  ["br", createBrotliDecompress],
]);

export function isCertificateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && CERTIFICATE_ERRORS.has(String(error.code))) return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

/** Compatibility is confined to this origin; no process-wide TLS or fetch changes. */
export class PlannerTransport {
  private readonly notices = new Map<string, ConnectionWarning>();
  private untrusted = false;
  readonly origin: string;

  constructor(
    origin: string,
    private readonly notify: (warning: ConnectionWarning) => void = () => {},
  ) {
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Use a planner HTTP(S) origin.");
    this.origin = url.origin;
    const warning = httpWarning(this.origin);
    if (warning) this.warn(warning);
  }

  warnings() {
    return [...this.notices.values()];
  }
  usesUntrustedCertificate() {
    return this.untrusted;
  }

  private warn(warning: ConnectionWarning) {
    if (this.notices.has(warning.code)) return;
    this.notices.set(warning.code, warning);
    this.notify(warning);
  }

  acceptCertificateError(error: unknown) {
    if (this.untrusted || !isCertificateError(error)) return false;
    this.untrusted = true;
    this.warn({
      code: "TLS_UNTRUSTED",
      message:
        "The planner HTTPS certificate is not trusted. The connection is encrypted, but the server's identity is not verified.",
    });
    return true;
  }

  readonly request: typeof fetch = async (input, init) => {
    const request = new Request(input, { ...init, redirect: "error" });
    if (new URL(request.url).origin !== this.origin)
      throw new Error("Planner requests must stay on the configured origin.");
    request.signal.throwIfAborted();
    if (!this.untrusted) {
      try {
        return await fetch(request.clone());
      } catch (error) {
        request.signal.throwIfAborted();
        // Only certificate failures before HTTP delivery can use this fallback.
        if (new URL(request.url).protocol !== "https:" || !isCertificateError(error)) throw error;
        this.acceptCertificateError(error);
      }
    }
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(
        request.url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          rejectUnauthorized: false,
          agent: false,
          signal: request.signal,
        },
        (incoming) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
            else if (value !== undefined) headers.set(key, value);
          }
          // Native HTTPS does not decode response content like fetch does.
          const decoder = DECODERS.get(headers.get("content-encoding") ?? "");
          const stream = decoder ? incoming.pipe(decoder()) : incoming;
          if (decoder) incoming.on("error", (error) => stream.destroy(error));
          if (decoder) {
            headers.delete("content-encoding");
            headers.delete("content-length");
          }
          const status = incoming.statusCode ?? 500;
          if ([204, 205, 304].includes(status) || request.method === "HEAD") incoming.resume();
          resolve(
            new Response(
              [204, 205, 304].includes(status) || request.method === "HEAD"
                ? null
                : (Readable.toWeb(stream) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        },
      );
      outgoing.on("error", reject);
      if (body) outgoing.write(body);
      outgoing.end();
    });
  };
}
