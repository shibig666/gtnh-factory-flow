import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { randomUUID } from "./random-id";

afterEach(() => vi.unstubAllGlobals());

it("creates distinct RFC 4122 v4 IDs when HTTP has getRandomValues but no callable randomUUID", () => {
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    randomUUID: undefined,
  });
  const ids = Array.from({ length: 100 }, () => randomUUID());
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
