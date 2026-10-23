import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { expect, it } from "vitest";
import { loadCertificate } from "./certificate.mjs";

it("reuses a valid self-signed LAN certificate and replaces corrupted key material", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gtnh-tls-"));
  try {
    const original = await loadCertificate(directory, "192.168.1.20");
    const cert = new X509Certificate(original.cert);
    expect(cert.checkIP("192.168.1.20")).toBe("192.168.1.20");
    expect(cert.checkIP("192.168.1.21")).toBeUndefined();
    expect(cert.verify(cert.publicKey)).toBe(true);
    const reused = await loadCertificate(directory, "192.168.1.20");
    expect(reused.generated).toBe(false);
    expect(new X509Certificate(reused.cert).fingerprint256).toBe(cert.fingerprint256);
    await writeFile(original.certPath.replace("-cert.pem", "-key.pem"), "broken test key");
    const replaced = await loadCertificate(directory, "192.168.1.20");
    expect(replaced.generated).toBe(true);
    expect(new X509Certificate(replaced.cert).fingerprint256).not.toBe(cert.fingerprint256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
