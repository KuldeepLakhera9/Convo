// Browser WebCrypto E2EE implementation
// Architecture: Per-message X3DH (ECIES-style)
// - Sender generates a fresh ephemeral key for EVERY message
// - Message key is derived directly from the X3DH shared secret
// - No ratchet chain state needed — eliminates all session sync bugs
// - Each message is independently decryptable with only IK+SPK (no history required)

// ─── Buffer helpers ───────────────────────────────────────────────────────────

function bufferToBase64(buf: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(buf));
  return btoa(bin);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ─── Public Key import/export (SPKI) ─────────────────────────────────────────

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return bufferToBase64(await window.crypto.subtle.exportKey('spki', key));
}

export async function importPublicKey(b64: string): Promise<CryptoKey> {
  return window.crypto.subtle.importKey(
    'spki', base64ToBuffer(b64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true, []
  );
}

// ─── Device key generation ────────────────────────────────────────────────────

export async function generateDeviceKeyPair() {
  const params = { name: 'ECDH', namedCurve: 'P-256' };
  const ik = await window.crypto.subtle.generateKey(params, true, ['deriveKey', 'deriveBits']);
  const spk = await window.crypto.subtle.generateKey(params, true, ['deriveKey', 'deriveBits']);
  return { ik, spk };
}

// ─── ECDH shared secret ───────────────────────────────────────────────────────

async function computeDH(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const bits = await window.crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey }, privateKey, 256
  );
  return new Uint8Array(bits);
}

// ─── Derive AES message key from combined DH material ────────────────────────

async function deriveMessageKey(
  dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array
): Promise<Uint8Array> {
  const combined = new Uint8Array(dh1.length + dh2.length + dh3.length);
  combined.set(dh1, 0);
  combined.set(dh2, dh1.length);
  combined.set(dh3, dh1.length + dh2.length);

  const masterKey = await window.crypto.subtle.importKey(
    'raw', combined.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits']
  );

  const keyBits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('convo-message-key-v1'),
    },
    masterKey,
    256
  );

  return new Uint8Array(keyBits);
}

// ─── X3DH Sender: encrypt for a recipient ────────────────────────────────────
// Returns a fresh message key + the ephemeral public key the receiver needs.
// Call this once per recipient device per message.

export async function x3dhInitiate(
  localIK: { privateKey: CryptoKey },
  remoteIKPubB64: string,
  remoteSPKPubB64: string
): Promise<{ messageKey: Uint8Array; ephemeralPublicKey: string }> {
  // Generate a brand-new ephemeral key for THIS message
  const ek = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );

  const remoteIKPub = await importPublicKey(remoteIKPubB64);
  const remoteSPKPub = await importPublicKey(remoteSPKPubB64);

  // Three DH agreements (X3DH)
  const dh1 = await computeDH(localIK.privateKey, remoteSPKPub);   // IK_A · SPK_B
  const dh2 = await computeDH(ek.privateKey, remoteIKPub);          // EK_A · IK_B
  const dh3 = await computeDH(ek.privateKey, remoteSPKPub);         // EK_A · SPK_B

  const messageKey = await deriveMessageKey(dh1, dh2, dh3);
  const ephemeralPublicKey = await exportPublicKey(ek.publicKey);

  return { messageKey, ephemeralPublicKey };
}

// ─── X3DH Receiver: derive the same message key ──────────────────────────────
// Uses the ephemeralPublicKey embedded in the message payload.
// Produces the identical message key as the sender — no session state required.

export async function x3dhReceive(
  localIK: { privateKey: CryptoKey },
  localSPK: { privateKey: CryptoKey },
  remoteIKPubB64: string,
  remoteEKPubB64: string
): Promise<Uint8Array> {
  const remoteIKPub = await importPublicKey(remoteIKPubB64);
  const remoteEKPub = await importPublicKey(remoteEKPubB64);

  // Mirror of sender's three DH agreements (ECDH is commutative)
  const dh1 = await computeDH(localSPK.privateKey, remoteIKPub);   // SPK_B · IK_A
  const dh2 = await computeDH(localIK.privateKey, remoteEKPub);    // IK_B · EK_A
  const dh3 = await computeDH(localSPK.privateKey, remoteEKPub);   // SPK_B · EK_A

  return deriveMessageKey(dh1, dh2, dh3);
}

// ─── AES-GCM Encrypt ─────────────────────────────────────────────────────────

export async function encryptSymmetric(
  plaintext: string,
  keyBytes: Uint8Array
): Promise<{ ciphertext: string; iv: string }> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await window.crypto.subtle.importKey(
    'raw', keyBytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const ciphertextBuf = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  );
  return { ciphertext: bufferToBase64(ciphertextBuf), iv: bufferToBase64(iv.buffer) };
}

// ─── AES-GCM Decrypt ─────────────────────────────────────────────────────────

export async function decryptSymmetric(
  ciphertextB64: string,
  ivB64: string,
  keyBytes: Uint8Array
): Promise<string> {
  const ciphertext = base64ToBuffer(ciphertextB64);
  const iv = base64ToBuffer(ivB64);
  const cryptoKey = await window.crypto.subtle.importKey(
    'raw', keyBytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['decrypt']
  );
  const decryptedBuf = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, cryptoKey, ciphertext
  );
  return new TextDecoder().decode(decryptedBuf);
}
