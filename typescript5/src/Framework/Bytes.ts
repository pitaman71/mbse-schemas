/**
 * Bytes: base64 and hex text for `Uint8Array`, without Node's `Buffer`, so the framework runs in browsers too.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));

/** Standard base64 with padding (RFC 4648 §4). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i] as number, bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[n >> 18] + (ALPHABET[(n >> 12) & 63] as string);
    out += b === undefined ? "==" : (ALPHABET[(n >> 6) & 63] as string) + (c === undefined ? "=" : ALPHABET[n & 63]);
  }
  return out;
}

/** Decodes base64 text that is already known to be valid, padded, standard base64. */
export function fromBase64(text: string): Uint8Array {
  const body = text.replace(/=+$/, "");
  const out = new Uint8Array((body.length * 3) >> 2);
  let bits = 0;
  let count = 0;
  let j = 0;
  for (const char of body) {
    bits = (bits << 6) | (INDEX.get(char) as number);
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[j++] = (bits >> count) & 0xff;
    }
  }
  return out;
}

/** Lowercase hex, two digits per byte. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
