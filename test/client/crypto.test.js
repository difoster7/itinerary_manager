import { describe, it, expect } from "vitest";
import {
  deriveKeys,
  encryptJson,
  decryptJson,
  tokenHash,
  toB64,
  fromB64,
} from "../../public/js/crypto.js";
import { SALT, PBKDF2_ITERATIONS } from "../../public/js/config.js";

const salt = toB64(new Uint8Array(16).fill(7));
const FAST = 1000; // iterations for speed in tests

describe("crypto", () => {
  it("config has a 16-byte salt and 600k iterations", () => {
    expect(fromB64(SALT)).toHaveLength(16);
    expect(PBKDF2_ITERATIONS).toBe(600000);
  });

  it("base64 round-trips large byte arrays", () => {
    const bytes = new Uint8Array(300000).map((_, i) => i % 256);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  it("token derivation is deterministic and 32 bytes", async () => {
    const a = await deriveKeys("correct horse battery staple", salt, FAST);
    const b = await deriveKeys("correct horse battery staple", salt, FAST);
    expect(a.token).toBe(b.token);
    expect(fromB64(a.token)).toHaveLength(32);
  });

  it("trims and NFKC-normalizes the passphrase", async () => {
    const a = await deriveKeys("café tango", salt, FAST);
    const b = await deriveKeys(" café tango ", salt, FAST);
    expect(b.token).toBe(a.token);
  });

  it("different passphrase or salt gives a different token", async () => {
    const a = await deriveKeys("one two three", salt, FAST);
    const b = await deriveKeys("one two four", salt, FAST);
    const c = await deriveKeys(
      "one two three",
      toB64(new Uint8Array(16)),
      FAST,
    );
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
  });

  it("encKey is not extractable", async () => {
    const { encKey } = await deriveKeys("x y z", salt, FAST);
    expect(encKey.extractable).toBe(false);
  });

  it("encrypt/decrypt round trip with fresh IVs", async () => {
    const { encKey } = await deriveKeys("x y z", salt, FAST);
    const value = { a: 1, s: "ñandú" };
    const b1 = await encryptJson(encKey, value);
    const b2 = await encryptJson(encKey, value);
    const p1 = JSON.parse(b1);
    expect(p1.v).toBe(1);
    expect(fromB64(p1.iv)).toHaveLength(12);
    expect(p1.iv).not.toBe(JSON.parse(b2).iv);
    expect(b1).not.toContain("ñandú");
    expect(await decryptJson(encKey, b1)).toEqual(value);
  });

  it("decrypt with the wrong key throws", async () => {
    const { encKey } = await deriveKeys("x y z", salt, FAST);
    const { encKey: other } = await deriveKeys("x y q", salt, FAST);
    const blob = await encryptJson(encKey, { a: 1 });
    await expect(decryptJson(other, blob)).rejects.toThrow();
  });

  it("tokenHash matches SHA-256 of the raw token bytes", async () => {
    const token = toB64(new Uint8Array(32).fill(1));
    expect(await tokenHash(token)).toBe(
      "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793",
    );
  });
});
