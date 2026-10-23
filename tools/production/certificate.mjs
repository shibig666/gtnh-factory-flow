import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { generate } from "selfsigned";

export async function loadCertificate(directory, host) {
  await mkdir(directory, { recursive: true });
  const name = createHash("sha256").update(host).digest("hex").slice(0, 20);
  const keyPath = path.join(directory, `${name}-key.pem`);
  const certPath = path.join(directory, `${name}-cert.pem`);
  try {
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    const x509 = new X509Certificate(cert);
    const matchesHost = isIP(host) ? x509.checkIP(host) : x509.checkHost(host);
    if (
      matchesHost &&
      Date.parse(x509.validFrom) <= Date.now() &&
      Date.parse(x509.validTo) > Date.now() + 86400000 &&
      x509.checkPrivateKey(createPrivateKey(key))
    )
      return { key, cert, certPath, generated: false };
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
    // A missing or invalid certificate is replaced; permissions errors are reported.
  }
  const notBeforeDate = new Date(Date.now() - 300000);
  const notAfterDate = new Date(Date.now() + 365 * 86400000);
  const pems = await generate([{ name: "commonName", value: host }], {
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [{ type: isIP(host) ? 7 : 2, ...(isIP(host) ? { ip: host } : { value: host }) }],
      },
    ],
  });
  // Validate key material before making it available to the listener.
  createPublicKey(pems.private);
  await writeFile(keyPath, pems.private, { mode: 0o600 });
  await writeFile(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert, certPath, generated: true };
}
