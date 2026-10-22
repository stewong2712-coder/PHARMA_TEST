/**
 * End-to-end simulation of the PharmaChain pipeline on a local PoA-style chain.
 *
 *   npx hardhat run scripts/simulate.js
 *
 * Scenario: an insulin batch (2-8 C) travels Manufacturer -> Distributor ->
 * Pharmacy -> Patient, while a second batch suffers a cold-chain failure and
 * is quarantined automatically. Writes reports/simulation.json.
 * All organisation names are fictional.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { simulateReadings, aggregateWindows, signWindow } = require("../oracle/gateway");
const { LocalPinStore, encryptForConsortium } = require("../offchain/ipfs");

const { ethers } = hre;
const VERDICTS = ["Genuine", "GenuineAlreadyDispensed", "UnknownSerial", "UnknownBatch", "Recalled", "Quarantined", "Expired"];
const STATUS = ["None", "Manufactured", "InTransit", "Received", "Quarantined", "Recalled", "Exhausted"];

async function main() {
  const [regulator, manufacturer, distributor, pharmacy, gateway, inspector] = await ethers.getSigners();
  const actors = {
    regulator: { name: "National Medicines Regulator (fictional)", address: regulator.address },
    manufacturer: { name: "Lumora Biologics Ltd (fictional)", address: manufacturer.address },
    distributor: { name: "ColdRoute Distribution (fictional)", address: distributor.address },
    pharmacy: { name: "Westside Community Pharmacy (fictional)", address: pharmacy.address },
    gateway: { name: "IoT oracle gateway", address: gateway.address },
    inspector: { name: "QA inspector", address: inspector.address },
  };
  const gas = {};
  const record = async (label, txPromise) => {
    const rc = await (await txPromise).wait();
    gas[label] = gas[label] || [];
    gas[label].push(Number(rc.gasUsed));
    return rc;
  };

  // ---- Deploy and onboard consortium members ---------------------------------
  const pc = await (await ethers.getContractFactory("PharmaChain")).deploy(regulator.address);
  const deployRc = await pc.deploymentTransaction().wait();
  gas.deploy = [Number(deployRc.gasUsed)];
  await record("grantRole", pc.grantRole(await pc.MANUFACTURER_ROLE(), manufacturer.address));
  await record("grantRole", pc.grantRole(await pc.DISTRIBUTOR_ROLE(), distributor.address));
  await record("grantRole", pc.grantRole(await pc.PHARMACY_ROLE(), pharmacy.address));
  await record("grantRole", pc.grantRole(await pc.ORACLE_ROLE(), gateway.address));
  await record("grantRole", pc.grantRole(await pc.INSPECTOR_ROLE(), inspector.address));

  // ---- Off-chain documents -> IPFS CIDs ---------------------------------------
  const ipfs = new LocalPinStore();
  const coa = Buffer.from(JSON.stringify({ doc: "Certificate of Analysis", product: "Insulin glargine 100 U/mL pen", lot: "INS-2026-0412", potency: "99.1%", sterility: "Pass", releasedBy: "QP 0193" }));
  const { key: coaKey, payload: coaEnc } = encryptForConsortium(coa);
  const docsCid = await ipfs.add(coaEnc);

  // ---- Serialisation: 1,000 packs -> one Merkle root --------------------------
  const serials = Array.from({ length: 1000 }, (_, i) => `SN${String(500000 + i)}`);
  const tree = StandardMerkleTree.of(serials.map((s) => [s]), ["string"]);
  const now = await time.latest();
  const base = {
    gtin: "05099999000013",
    expiry: now + 540 * 86400,
    quantity: serials.length,
    minTempDeci: 20,
    maxTempDeci: 80,
    excursionToleranceSec: 1800,
    serialRoot: tree.root,
    docsCid,
  };
  const good = { ...base, lot: "INS-2026-0412" };
  const bad = { ...base, lot: "INS-2026-0413" };
  await record("createBatch", pc.connect(manufacturer).createBatch(good));
  await record("createBatch", pc.connect(manufacturer).createBatch(bad));
  const goodId = await pc.batchIdOf(good.gtin, good.lot);
  const badId = await pc.batchIdOf(bad.gtin, bad.lot);

  // ---- Bind data-loggers ------------------------------------------------------
  const loggerA = ethers.Wallet.createRandom();
  const loggerB = ethers.Wallet.createRandom();
  await record("bindSensor", pc.connect(manufacturer).bindSensor(goodId, loggerA.address));
  await record("bindSensor", pc.connect(manufacturer).bindSensor(badId, loggerB.address));

  // ---- Hand-over 1: Manufacturer -> Distributor (with DSCSA T3 statement) ------
  const t3a = Buffer.from(JSON.stringify({ T3: "transaction statement", from: actors.manufacturer.name, to: actors.distributor.name, lot: good.lot }));
  const t3aCid = await ipfs.add(t3a);
  await record("initiateTransfer", pc.connect(manufacturer).initiateTransfer(goodId, distributor.address, ethers.keccak256(t3a)));
  await record("initiateTransfer", pc.connect(manufacturer).initiateTransfer(badId, distributor.address, ethers.keccak256(t3a)));

  // ---- Six-hour road leg: telemetry ------------------------------------------
  const tripStart = Math.floor((await time.latest()) / 900) * 900 + 900;
  const readingsA = simulateReadings({ start: tripStart, minutes: 360, excursions: [{ from: 150, to: 162, base: 8.0, peak: 9.1 }] });
  const readingsB = simulateReadings({ start: tripStart, minutes: 360, excursions: [{ from: 190, to: 250, base: 8.5, peak: 13.4 }] });
  const winA = aggregateWindows(readingsA);
  const winB = aggregateWindows(readingsB);
  const telemetry = { A: [], B: [] };
  let quarantinedAtWindow = null;
  for (let i = 0; i < winA.length; i++) {
    await time.increaseTo(winA[i].windowEnd);
    const a = await signWindow(pc, loggerA, goodId, winA[i], i + 1);
    await record("recordTelemetry", pc.connect(gateway).recordTelemetry(a.t, a.sig));
    const b = await signWindow(pc, loggerB, badId, winB[i], i + 1);
    const rc = await record("recordTelemetry", pc.connect(gateway).recordTelemetry(b.t, b.sig));
    if (quarantinedAtWindow === null && rc.logs.some((l) => { try { return pc.interface.parseLog(l).name === "BatchQuarantined"; } catch { return false; } })) quarantinedAtWindow = i;
    telemetry.A.push({ start: winA[i].windowStart, min: winA[i].minTempDeci / 10, max: winA[i].maxTempDeci / 10 });
    telemetry.B.push({ start: winB[i].windowStart, min: winB[i].minTempDeci / 10, max: winB[i].maxTempDeci / 10 });
  }
  const rawLogCid = await ipfs.add(Buffer.from(JSON.stringify(readingsA)));

  await record("acceptTransfer", pc.connect(distributor).acceptTransfer(goodId));
  let badAcceptBlocked = false;
  try { await pc.connect(distributor).acceptTransfer.staticCall(badId); } catch { badAcceptBlocked = true; }

  // ---- Hand-over 2: Distributor -> Pharmacy ----------------------------------
  const t3b = Buffer.from(JSON.stringify({ T3: "transaction statement", from: actors.distributor.name, to: actors.pharmacy.name, lot: good.lot }));
  await record("initiateTransfer", pc.connect(distributor).initiateTransfer(goodId, pharmacy.address, ethers.keccak256(t3b)));
  await time.increase(3600);
  await record("acceptTransfer", pc.connect(pharmacy).acceptTransfer(goodId));

  // ---- Point of dispense and patient scans ------------------------------------
  const scanned = serials[417];
  const proof = tree.getProof([scanned]);
  const beforeDispense = await pc.verifyPack(goodId, scanned, proof);
  await record("dispense", pc.connect(pharmacy).dispense(goodId, scanned, proof));
  const afterDispense = await pc.verifyPack(goodId, scanned, proof);
  const counterfeit = await pc.verifyPack(goodId, "SN999999", proof);
  const quarantinedPack = await pc.verifyPack(badId, serials[3], tree.getProof([serials[3]]));
  const verifyGas = await pc.verifyPack.estimateGas(goodId, scanned, proof);

  // ---- Integrity check of an off-chain document -------------------------------
  const tamperedT3 = Buffer.from(t3a.toString().replace("ColdRoute", "ShadowRoute"));
  const docIntegrity = {
    originalMatchesLedger: ethers.keccak256(t3a) === (await pc.getCustodyLog(goodId))[1].handoverDocHash,
    tamperedMatchesLedger: ethers.keccak256(tamperedT3) === (await pc.getCustodyLog(goodId))[1].handoverDocHash,
  };

  const goodBatch = await pc.getBatch(goodId);
  const badBatch = await pc.getBatch(badId);
  const avg = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
  const out = {
    generatedAt: new Date().toISOString(),
    network: { chainId: Number((await ethers.provider.getNetwork()).chainId), note: "Hardhat EVM standing in for a QBFT consortium chain" },
    actors,
    contract: await pc.getAddress(),
    documents: { coaCid: docsCid, coaKeyFingerprint: ethers.keccak256(coaKey).slice(0, 18), t3aCid, rawSensorLogCid: rawLogCid },
    serialisation: { packs: serials.length, merkleRoot: tree.root, proofLength: proof.length },
    batches: {
      good: { id: goodId, lot: good.lot, status: STATUS[Number(goodBatch.status)], excursionSec: Number(goodBatch.excursionSec), dispensed: Number(goodBatch.dispensed), custodian: goodBatch.custodian },
      bad: { id: badId, lot: bad.lot, status: STATUS[Number(badBatch.status)], excursionSec: Number(badBatch.excursionSec), quarantinedAtWindow, downstreamAcceptBlocked: badAcceptBlocked },
    },
    verification: {
      beforeDispense: VERDICTS[Number(beforeDispense.verdict)],
      afterDispense: VERDICTS[Number(afterDispense.verdict)],
      counterfeitSerial: VERDICTS[Number(counterfeit.verdict)],
      quarantinedBatchPack: VERDICTS[Number(quarantinedPack.verdict)],
      verifyPackGasIfOnChain: Number(verifyGas),
    },
    docIntegrity,
    telemetry,
    gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, { calls: v.length, avg: avg(v), min: Math.min(...v), max: Math.max(...v) }])),
  };
  fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "reports", "simulation.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, telemetry: `${telemetry.A.length} windows per batch` }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
