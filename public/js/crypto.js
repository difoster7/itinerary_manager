import { PBKDF2_ITERATIONS } from "./config.js";

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function toB64(bytes) {
  let s = "";
  // Chunked: spreading a huge array into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export const fromB64 = (s) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const hkdf = (info) => ({
  name: "HKDF",
  hash: "SHA-256",
  salt: new Uint8Array(0),
  info: te.encode(info),
});

export async function deriveKeys(
  passphrase,
  saltB64,
  iterations = PBKDF2_ITERATIONS,
) {
  const pw = te.encode(passphrase.normalize("NFKC").trim());
  const base = await subtle.importKey("raw", pw, "PBKDF2", false, [
    "deriveBits",
  ]);
  const master = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations },
    base,
    256,
  );
  const hk = await subtle.importKey("raw", master, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
  const encKey = await subtle.deriveKey(
    hkdf("enc-v1"),
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const token = toB64(
    new Uint8Array(await subtle.deriveBits(hkdf("auth-v1"), hk, 256)),
  );
  return { encKey, token };
}

export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(JSON.stringify(value)),
  );
  return JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
}

export async function decryptJson(key, blob) {
  const { v, iv, ct } = JSON.parse(blob);
  if (v !== 1) throw new Error(`Unsupported blob version ${v}`);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(iv) },
    key,
    fromB64(ct),
  );
  return JSON.parse(td.decode(pt));
}

export async function tokenHash(token) {
  const d = new Uint8Array(await subtle.digest("SHA-256", fromB64(token)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
