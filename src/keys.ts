import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type CryptoKey,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  importPKCS8,
  type JWK,
} from "jose";

export const ALG = "EdDSA";

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
}

async function fromPrivate(privateKey: CryptoKey, kid: string): Promise<SigningKey> {
  const jwk = await exportJWK(privateKey);
  const { d: _d, ...pub } = jwk;
  const publicKey = (await importJWK({ ...pub, alg: ALG }, ALG)) as CryptoKey;
  return { kid, privateKey, publicKey, publicJwk: { ...pub, alg: ALG, use: "sig", kid } };
}

/** Generates a fresh Ed25519 signing key. */
export async function generateSigningKey(kid: string = randomUUID()): Promise<SigningKey> {
  const { privateKey } = await generateKeyPair(ALG, { crv: "Ed25519", extractable: true });
  return fromPrivate(privateKey, kid);
}

/** Imports an Ed25519 private key from PKCS#8 PEM. */
export async function importSigningKey(pem: string, kid: string): Promise<SigningKey> {
  const privateKey = await importPKCS8(pem, ALG, { extractable: true });
  return fromPrivate(privateKey, kid);
}

/**
 * Loads the signing key from `path`, creating it with mode 0600 on first use.
 * The key id is derived from the file so that it stays stable across restarts.
 */
export async function loadOrCreateSigningKey(path: string): Promise<SigningKey> {
  const existing = readKeyFile(path);
  if (existing !== undefined) return importKeyFile(existing);
  const key = await generateSigningKey();
  const pem = await exportPKCS8(key.privateKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // "wx" fails if another process created the file first; use that key instead.
    writeFileSync(path, `# kid: ${key.kid}\n${pem}`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return importKeyFile(readFileSync(path, "utf8"));
  }
  return key;
}

function readKeyFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function importKeyFile(raw: string): Promise<SigningKey> {
  const kid = /^# kid: (\S+)$/m.exec(raw)?.[1] ?? "default";
  return importSigningKey(raw.replace(/^#.*\n/gm, ""), kid);
}
