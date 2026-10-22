/**
 * IoT oracle gateway (off-chain).
 *
 * A data-logger inside the shipper samples temperature once a minute and
 * signs nothing per reading (too costly for a battery device). The gateway:
 *   1. groups raw readings into fixed windows (default 15 minutes),
 *   2. builds a Merkle root over the window's raw readings (the raw file goes
 *      to IPFS so an auditor can re-check any minute later),
 *   3. asks the data-logger's secure element to sign the window summary,
 *   4. submits the signed summary to PharmaChain.recordTelemetry().
 *
 * The contract re-checks the signature, so a compromised gateway can delay
 * data but cannot forge or alter it.
 */
const { ethers } = require("ethers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

/** Simulated logger: 2-8 C product with a door-open excursion. */
function simulateReadings({ start, minutes, excursions = [] }) {
  const readings = [];
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let m = 0; m < minutes; m++) {
    let temp = 5.0 + Math.sin(m / 37) * 0.8 + (rand() - 0.5) * 0.4; // ~4.0-6.0 C normal band
    for (const e of excursions) {
      if (m >= e.from && m < e.to) {
        const mid = (e.from + e.to) / 2;
        const shape = 1 - Math.abs(m - mid) / ((e.to - e.from) / 2 + 1);
        temp = e.base + (e.peak - e.base) * shape;
      }
    }
    readings.push({ ts: start + m * 60, tempDeci: Math.round(temp * 10) });
  }
  return readings;
}

function aggregateWindows(readings, windowSec = 900) {
  const windows = new Map();
  for (const r of readings) {
    const key = Math.floor(r.ts / windowSec) * windowSec;
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push(r);
  }
  return [...windows.entries()].map(([windowStart, rs]) => {
    const tree = StandardMerkleTree.of(rs.map((r) => [r.ts, r.tempDeci]), ["uint64", "int16"]);
    return {
      windowStart,
      windowEnd: windowStart + windowSec,
      minTempDeci: Math.min(...rs.map((r) => r.tempDeci)),
      maxTempDeci: Math.max(...rs.map((r) => r.tempDeci)),
      readingsRoot: tree.root,
      count: rs.length,
      raw: rs,
    };
  });
}

async function signWindow(contract, sensorWallet, batchId, w, nonce) {
  const t = {
    batchId,
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    minTempDeci: w.minTempDeci,
    maxTempDeci: w.maxTempDeci,
    readingsRoot: w.readingsRoot,
    nonce,
  };
  const digest = await contract.telemetryDigest(t);
  const sig = await sensorWallet.signMessage(ethers.getBytes(digest));
  return { t, sig };
}

module.exports = { simulateReadings, aggregateWindows, signWindow };
