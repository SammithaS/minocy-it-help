/**
 * Signed, expiring tokens for links in emails ("Did this fix it?", manager approvals in Phase 6).
 * HMAC-SHA256 over the payload with BETTER_AUTH_SECRET; no database lookup needed to verify.
 */

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function key(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface LinkPayload {
  /** What the link is for, e.g. "confirm". */
  purpose: string;
  /** Subject id, e.g. a ticket id. */
  sub: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

export async function signLink(secret: string, payload: LinkPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyLink(secret: string, token: string, purpose: string, now = Date.now()): Promise<LinkPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as LinkPayload;
    if (payload.purpose !== purpose || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
