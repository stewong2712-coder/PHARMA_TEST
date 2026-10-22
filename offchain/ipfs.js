/**
 * Off-chain document handling.
 *
 * Heavy documents (certificate of analysis, batch manufacturing record,
 * DSCSA transaction statements, raw sensor logs) are pinned to IPFS by each
 * consortium member's own node. Only the content identifier (CID) goes
 * on-chain. Because a CID is derived from the SHA-256 of the bytes, any later
 * edit to a document produces a different CID and no longer matches the
 * ledger: tamper-evidence without storing the file on-chain.
 *
 * This module computes CIDv1 (raw codec, sha2-256) locally, exactly as an
 * IPFS node would for a single-block file, so the prototype runs offline.
 * Confidential documents are encrypted (AES-256-GCM) before pinning; the key
 * is shared point-to-point with the counterparties entitled to read it.
 */
const crypto = require("crypto");

async function cidOf(bytes) {
  const { CID } = await import("multiformats/cid");
  const raw = await import("multiformats/codecs/raw");
  const { sha256 } = await import("multiformats/hashes/sha2");
  const hash = await sha256.digest(bytes);
  return CID.create(1, raw.code, hash).toString();
}

function encryptForConsortium(plainBytes) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { key, payload: Buffer.concat([iv, tag, ciphertext]) };
}

function decrypt(key, payload) {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

/** In-memory stand-in for a pinning service: CID -> bytes. */
class LocalPinStore {
  constructor() {
    this.blocks = new Map();
  }
  async add(bytes) {
    const cid = await cidOf(bytes);
    this.blocks.set(cid, Buffer.from(bytes));
    return cid;
  }
  async get(cid) {
    const bytes = this.blocks.get(cid);
    if (!bytes) throw new Error(`CID not pinned: ${cid}`);
    // Integrity check on read: recompute the CID from the bytes returned
    if ((await cidOf(bytes)) !== cid) throw new Error("Integrity failure: content does not match CID");
    return bytes;
  }
}

module.exports = { cidOf, encryptForConsortium, decrypt, LocalPinStore };
