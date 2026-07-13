// Browser WebCrypto E2EE implementation of X3DH & Double Ratchet

// 1. Buffer Helper functions
function bufferToBase64(buf: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(buf));
  return btoa(bin);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    buf[i] = bin.charCodeAt(i);
  }
  return buf.buffer;
}

// 2. Public Key import/export (SPKI format)
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await window.crypto.subtle.exportKey('spki', key);
  return bufferToBase64(exported);
}

export async function importPublicKey(b64: string): Promise<CryptoKey> {
  const buf = base64ToBuffer(b64);
  return await window.crypto.subtle.importKey(
    'spki',
    buf,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

// 3. Generate local device Identity and Signed Prekey pairs
export async function generateDeviceKeyPair() {
  const ik = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // Must be extractable so we can export public key
    ['deriveKey', 'deriveBits']
  );
  const spk = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
  return { ik, spk };
}

// Compute ECDH Shared Secret
async function computeDH(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const bits = await window.crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  return new Uint8Array(bits);
}

// 4. X3DH Session Agreement - Initiation side (Alice)
export async function x3dhInitiate(
  localIK: { privateKey: CryptoKey },
  remoteIKPubB64: string,
  remoteSPKPubB64: string
) {
  // Generate Ephemeral Key (EK)
  const ek = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );

  const remoteIKPub = await importPublicKey(remoteIKPubB64);
  const remoteSPKPub = await importPublicKey(remoteSPKPubB64);

  // Compute DH agreements
  const dh1 = await computeDH(localIK.privateKey, remoteSPKPub);
  const dh2 = await computeDH(ek.privateKey, remoteIKPub);
  const dh3 = await computeDH(ek.privateKey, remoteSPKPub);

  // Combine derived DH bytes
  const combined = new Uint8Array(dh1.length + dh2.length + dh3.length);
  combined.set(dh1, 0);
  combined.set(dh2, dh1.length);
  combined.set(dh3, dh1.length + dh2.length);

  // HKDF to derive Root Key (RK)
  const masterKey = await window.crypto.subtle.importKey(
    'raw',
    combined.buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveBits']
  );

  const rkBits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('Convo-E2EE-Master'),
    },
    masterKey,
    256
  );

  const ekPubB64 = await exportPublicKey(ek.publicKey);

  return {
    rootKey: new Uint8Array(rkBits),
    ephemeralPublicKey: ekPubB64,
  };
}

// X3DH Session Agreement - Receiving side (Bob)
export async function x3dhReceive(
  localIK: { privateKey: CryptoKey },
  localSPK: { privateKey: CryptoKey },
  remoteIKPubB64: string,
  remoteEKPubB64: string
) {
  const remoteIKPub = await importPublicKey(remoteIKPubB64);
  const remoteEKPub = await importPublicKey(remoteEKPubB64);

  // Compute Bob's DH matches
  const dh1 = await computeDH(localSPK.privateKey, remoteIKPub);
  const dh2 = await computeDH(localIK.privateKey, remoteEKPub);
  const dh3 = await computeDH(localSPK.privateKey, remoteEKPub);

  const combined = new Uint8Array(dh1.length + dh2.length + dh3.length);
  combined.set(dh1, 0);
  combined.set(dh2, dh1.length);
  combined.set(dh3, dh1.length + dh2.length);

  const masterKey = await window.crypto.subtle.importKey(
    'raw',
    combined.buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveBits']
  );

  const rkBits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('Convo-E2EE-Master'),
    },
    masterKey,
    256
  );

  return new Uint8Array(rkBits);
}

// 5. Symmetric KDF chain advancement
export async function kdfStep(
  chainKey: Uint8Array,
  label: string
): Promise<{ nextChainKey: Uint8Array; messageKey: Uint8Array }> {
  const key = await window.crypto.subtle.importKey(
    'raw',
    chainKey.buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveBits']
  );

  const nextCkBits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(`${label}-next-ck`),
    },
    key,
    256
  );

  const mkBits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(`${label}-message-key`),
    },
    key,
    256
  );

  return {
    nextChainKey: new Uint8Array(nextCkBits),
    messageKey: new Uint8Array(mkBits),
  };
}

// 6. Symmetric AES-GCM Encrypt
export async function encryptSymmetric(
  plaintext: string,
  keyBytes: Uint8Array
): Promise<{ ciphertext: string; iv: string }> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await window.crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const ciphertextBuf = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  );

  return {
    ciphertext: bufferToBase64(ciphertextBuf),
    iv: bufferToBase64(iv.buffer),
  };
}

// Symmetric AES-GCM Decrypt
export async function decryptSymmetric(
  ciphertextB64: string,
  ivB64: string,
  keyBytes: Uint8Array
): Promise<string> {
  const ciphertext = base64ToBuffer(ciphertextB64);
  const iv = base64ToBuffer(ivB64);
  
  const cryptoKey = await window.crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decryptedBuf = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  return new TextDecoder().decode(decryptedBuf);
}
