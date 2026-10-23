export interface ConnectionWarning {
  code: "HTTP_UNENCRYPTED" | "TLS_UNTRUSTED";
  message: string;
}

export function isLoopback(origin: string) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
}

export function httpWarning(origin: string): ConnectionWarning | undefined {
  if (new URL(origin).protocol !== "http:" || isLoopback(origin)) return;
  return {
    code: "HTTP_UNENCRYPTED",
    message:
      "HTTP does not encrypt planner data, pairing credentials or edits. Other people on the network may read or change them.",
  };
}
