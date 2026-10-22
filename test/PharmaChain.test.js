const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

const Status = { None: 0n, Manufactured: 1n, InTransit: 2n, Received: 3n, Quarantined: 4n, Recalled: 5n, Exhausted: 6n };
const Verdict = { Genuine: 0n, GenuineAlreadyDispensed: 1n, UnknownSerial: 2n, UnknownBatch: 3n, Recalled: 4n, Quarantined: 5n, Expired: 6n };

const GTIN = "05012345678900";
const LOT = "INS-2026-0412";
const SERIALS = Array.from({ length: 8 }, (_, i) => `SN${String(100000 + i)}`);

async function deployFixture() {
  const [regulator, manufacturer, distributor, distributor2, pharmacy, gateway, inspector, outsider] = await ethers.getSigners();
  const sensor = ethers.Wallet.createRandom();
  const rogueSensor = ethers.Wallet.createRandom();

  const pc = await (await ethers.getContractFactory("PharmaChain")).deploy(regulator.address);

  await pc.grantRole(await pc.MANUFACTURER_ROLE(), manufacturer.address);
  await pc.grantRole(await pc.DISTRIBUTOR_ROLE(), distributor.address);
  await pc.grantRole(await pc.DISTRIBUTOR_ROLE(), distributor2.address);
  await pc.grantRole(await pc.PHARMACY_ROLE(), pharmacy.address);
  await pc.grantRole(await pc.ORACLE_ROLE(), gateway.address);
  await pc.grantRole(await pc.INSPECTOR_ROLE(), inspector.address);

  const tree = StandardMerkleTree.of(SERIALS.map((s) => [s]), ["string"]);
  const now = await time.latest();
  const input = {
    gtin: GTIN,
    lot: LOT,
    expiry: now + 365 * 24 * 3600,
    quantity: SERIALS.length,
    minTempDeci: 20, // 2.0 C
    maxTempDeci: 80, // 8.0 C
    excursionToleranceSec: 30 * 60, // 30 minutes cumulative
    serialRoot: tree.root,
    docsCid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  };
  const batchId = await pc.batchIdOf(GTIN, LOT);
  return { pc, regulator, manufacturer, distributor, distributor2, pharmacy, gateway, inspector, outsider, sensor, rogueSensor, tree, input, batchId };
}

async function createdFixture() {
  const f = await deployFixture();
  await f.pc.connect(f.manufacturer).createBatch(f.input);
  return f;
}

async function atPharmacyFixture() {
  const f = await createdFixture();
  const { pc, manufacturer, distributor, pharmacy, batchId } = f;
  await pc.connect(manufacturer).initiateTransfer(batchId, distributor.address, ethers.id("T3-manufacturer-to-distributor"));
  await pc.connect(distributor).acceptTransfer(batchId);
  await pc.connect(distributor).initiateTransfer(batchId, pharmacy.address, ethers.id("T3-distributor-to-pharmacy"));
  await pc.connect(pharmacy).acceptTransfer(batchId);
  return f;
}

async function signedWindow(pc, sensor, batchId, { start, end, min, max, nonce }) {
  const t = { batchId, windowStart: start, windowEnd: end, minTempDeci: min, maxTempDeci: max, readingsRoot: ethers.id(`readings-${nonce}`), nonce };
  const digest = await pc.telemetryDigest(t);
  const sig = await sensor.signMessage(ethers.getBytes(digest));
  return { t, sig };
}

describe("PharmaChain", function () {
  describe("Access control and batch creation", function () {
    it("lets only a manufacturer create a batch and records genesis custody", async function () {
      const { pc, manufacturer, outsider, input, batchId } = await loadFixture(deployFixture);
      await expect(pc.connect(outsider).createBatch(input)).to.be.revertedWithCustomError(pc, "AccessControlUnauthorizedAccount");
      await expect(pc.connect(manufacturer).createBatch(input)).to.emit(pc, "BatchCreated").withArgs(batchId, manufacturer.address, GTIN, LOT, 8, input.docsCid);
      const b = await pc.getBatch(batchId);
      expect(b.status).to.equal(Status.Manufactured);
      expect(b.custodian).to.equal(manufacturer.address);
      expect((await pc.getCustodyLog(batchId)).length).to.equal(1);
    });

    it("rejects duplicate batches and invalid parameters", async function () {
      const { pc, manufacturer, input } = await loadFixture(createdFixture);
      await expect(pc.connect(manufacturer).createBatch(input)).to.be.revertedWithCustomError(pc, "BatchExists");
      await expect(pc.connect(manufacturer).createBatch({ ...input, lot: "X1", minTempDeci: 90 })).to.be.revertedWithCustomError(pc, "InvalidInput");
      await expect(pc.connect(manufacturer).createBatch({ ...input, lot: "X2", quantity: 0 })).to.be.revertedWithCustomError(pc, "InvalidInput");
      await expect(pc.connect(manufacturer).createBatch({ ...input, lot: "X3", expiry: 1 })).to.be.revertedWithCustomError(pc, "InvalidInput");
    });
  });

  describe("Custody hand-over", function () {
    it("follows manufacturer -> distributor -> pharmacy with a two-step handshake", async function () {
      const { pc, manufacturer, distributor, pharmacy, batchId } = await loadFixture(createdFixture);
      await expect(pc.connect(manufacturer).initiateTransfer(batchId, distributor.address, ethers.id("T3-1")))
        .to.emit(pc, "TransferInitiated");
      expect((await pc.getBatch(batchId)).status).to.equal(Status.InTransit);
      // Custody does not move until the receiver signs
      expect((await pc.getBatch(batchId)).custodian).to.equal(manufacturer.address);
      await expect(pc.connect(pharmacy).acceptTransfer(batchId)).to.be.revertedWithCustomError(pc, "NotPendingCustodian");
      await pc.connect(distributor).acceptTransfer(batchId);
      await pc.connect(distributor).initiateTransfer(batchId, pharmacy.address, ethers.id("T3-2"));
      await pc.connect(pharmacy).acceptTransfer(batchId);
      const b = await pc.getBatch(batchId);
      expect(b.custodian).to.equal(pharmacy.address);
      expect(b.status).to.equal(Status.Received);
      const log = await pc.getCustodyLog(batchId);
      expect(log.length).to.equal(3);
      expect(log[2].handoverDocHash).to.equal(ethers.id("T3-2"));
    });

    it("blocks skipping a tier, non-custodians and unregistered recipients", async function () {
      const { pc, manufacturer, distributor, pharmacy, outsider, batchId } = await loadFixture(createdFixture);
      await expect(pc.connect(manufacturer).initiateTransfer(batchId, pharmacy.address, ethers.ZeroHash)).to.be.revertedWithCustomError(pc, "InvalidRecipient");
      await expect(pc.connect(manufacturer).initiateTransfer(batchId, outsider.address, ethers.ZeroHash)).to.be.revertedWithCustomError(pc, "InvalidRecipient");
      await expect(pc.connect(distributor).initiateTransfer(batchId, pharmacy.address, ethers.ZeroHash)).to.be.revertedWithCustomError(pc, "NotCustodian");
    });

    it("allows the sender to cancel an unaccepted hand-over", async function () {
      const { pc, manufacturer, distributor, batchId } = await loadFixture(createdFixture);
      await pc.connect(manufacturer).initiateTransfer(batchId, distributor.address, ethers.ZeroHash);
      await pc.connect(manufacturer).cancelTransfer(batchId);
      expect((await pc.getBatch(batchId)).status).to.equal(Status.Manufactured);
      await expect(pc.connect(distributor).acceptTransfer(batchId)).to.be.revertedWithCustomError(pc, "BadStatus");
    });

    it("refuses to ship an expired batch", async function () {
      const { pc, manufacturer, distributor, batchId, input } = await loadFixture(createdFixture);
      await time.increaseTo(input.expiry + 1);
      await expect(pc.connect(manufacturer).initiateTransfer(batchId, distributor.address, ethers.ZeroHash)).to.be.revertedWithCustomError(pc, "Expired");
    });
  });

  describe("Cold-chain oracle", function () {
    it("accepts in-range telemetry signed by the bound data-logger", async function () {
      const { pc, manufacturer, gateway, sensor, batchId } = await loadFixture(createdFixture);
      await pc.connect(manufacturer).bindSensor(batchId, sensor.address);
      const now = await time.latest();
      const { t, sig } = await signedWindow(pc, sensor, batchId, { start: now - 900, end: now, min: 41, max: 55, nonce: 1 });
      await expect(pc.connect(gateway).recordTelemetry(t, sig)).to.emit(pc, "TelemetryRecorded").and.not.to.emit(pc, "TemperatureExcursion");
      expect((await pc.getBatch(batchId)).excursionSec).to.equal(0);
      expect(await pc.lastTelemetryEnd(batchId)).to.equal(now);
    });

    it("rejects forged signatures, replayed nonces and non-gateway callers", async function () {
      const { pc, manufacturer, gateway, outsider, sensor, rogueSensor, batchId } = await loadFixture(createdFixture);
      await pc.connect(manufacturer).bindSensor(batchId, sensor.address);
      const now = await time.latest();
      const forged = await signedWindow(pc, rogueSensor, batchId, { start: now - 900, end: now, min: 40, max: 50, nonce: 1 });
      await expect(pc.connect(gateway).recordTelemetry(forged.t, forged.sig)).to.be.revertedWithCustomError(pc, "SensorNotBound");

      const good = await signedWindow(pc, sensor, batchId, { start: now - 900, end: now, min: 40, max: 50, nonce: 7 });
      await expect(pc.connect(outsider).recordTelemetry(good.t, good.sig)).to.be.revertedWithCustomError(pc, "AccessControlUnauthorizedAccount");
      await pc.connect(gateway).recordTelemetry(good.t, good.sig);
      await expect(pc.connect(gateway).recordTelemetry(good.t, good.sig)).to.be.revertedWithCustomError(pc, "StaleNonce");

      // Tampering with a signed value (gateway edits max temp) breaks the signature
      const tampered = { ...good.t, maxTempDeci: 60, nonce: 8 };
      await expect(pc.connect(gateway).recordTelemetry(tampered, good.sig)).to.be.revertedWithCustomError(pc, "SensorNotBound");
    });

    it("accumulates excursion time and auto-quarantines past tolerance", async function () {
      const { pc, manufacturer, distributor, gateway, sensor, batchId } = await loadFixture(createdFixture);
      await pc.connect(manufacturer).bindSensor(batchId, sensor.address);
      await pc.connect(manufacturer).initiateTransfer(batchId, distributor.address, ethers.ZeroHash);
      let now = await time.latest();
      // 20 minutes at 9.4 C: excursion logged, within the 30-minute tolerance
      const w1 = await signedWindow(pc, sensor, batchId, { start: now - 1200, end: now, min: 61, max: 94, nonce: 1 });
      await expect(pc.connect(gateway).recordTelemetry(w1.t, w1.sig)).to.emit(pc, "TemperatureExcursion").withArgs(batchId, 1200, 1200);
      expect((await pc.getBatch(batchId)).status).to.equal(Status.InTransit);

      await time.increase(900);
      now = await time.latest();
      // another 15 minutes out of range -> 35 minutes total -> quarantine
      const w2 = await signedWindow(pc, sensor, batchId, { start: now - 900, end: now, min: 85, max: 102, nonce: 2 });
      await expect(pc.connect(gateway).recordTelemetry(w2.t, w2.sig)).to.emit(pc, "BatchQuarantined");
      const b = await pc.getBatch(batchId);
      expect(b.status).to.equal(Status.Quarantined);
      expect(b.excursionSec).to.equal(2100);
      // A quarantined batch cannot be accepted downstream
      await expect(pc.connect(distributor).acceptTransfer(batchId)).to.be.revertedWithCustomError(pc, "BadStatus");
    });

    it("lets a QA inspector release a quarantined batch with an assessment on record", async function () {
      const { pc, inspector, outsider, batchId } = await loadFixture(atPharmacyFixture);
      await pc.connect(inspector).quarantine(batchId, "Damaged outer cartons");
      await expect(pc.connect(outsider).releaseFromQuarantine(batchId, "bafy-assess")).to.be.revertedWithCustomError(pc, "AccessControlUnauthorizedAccount");
      await expect(pc.connect(inspector).releaseFromQuarantine(batchId, "bafy-assess")).to.emit(pc, "BatchReleased");
      expect((await pc.getBatch(batchId)).status).to.equal(Status.Received);
    });
  });

  describe("Dispensing and patient verification", function () {
    it("verifies a genuine pack, then flags a second scan of the same serial", async function () {
      const { pc, pharmacy, tree, batchId } = await loadFixture(atPharmacyFixture);
      const serial = SERIALS[3];
      const proof = tree.getProof([serial]);
      expect((await pc.verifyPack(batchId, serial, proof)).verdict).to.equal(Verdict.Genuine);
      await expect(pc.connect(pharmacy).dispense(batchId, serial, proof)).to.emit(pc, "UnitDispensed");
      expect((await pc.verifyPack(batchId, serial, proof)).verdict).to.equal(Verdict.GenuineAlreadyDispensed);
      await expect(pc.connect(pharmacy).dispense(batchId, serial, proof)).to.be.revertedWithCustomError(pc, "AlreadyDispensed");
    });

    it("detects counterfeit serials and unknown batches", async function () {
      const { pc, pharmacy, tree, batchId } = await loadFixture(atPharmacyFixture);
      const proof = tree.getProof([SERIALS[0]]);
      expect((await pc.verifyPack(batchId, "SN999999", proof)).verdict).to.equal(Verdict.UnknownSerial);
      expect((await pc.verifyPack(ethers.id("fake"), SERIALS[0], proof)).verdict).to.equal(Verdict.UnknownBatch);
      await expect(pc.connect(pharmacy).dispense(batchId, "SN999999", proof)).to.be.revertedWithCustomError(pc, "InvalidProof");
    });

    it("propagates a recall to every pack and blocks dispensing", async function () {
      const { pc, manufacturer, pharmacy, outsider, tree, batchId } = await loadFixture(atPharmacyFixture);
      await expect(pc.connect(outsider).recall(batchId, "x")).to.be.revertedWithCustomError(pc, "NotCustodian");
      await expect(pc.connect(manufacturer).recall(batchId, "Out-of-spec potency")).to.emit(pc, "BatchRecalled");
      const proof = tree.getProof([SERIALS[1]]);
      expect((await pc.verifyPack(batchId, SERIALS[1], proof)).verdict).to.equal(Verdict.Recalled);
      await expect(pc.connect(pharmacy).dispense(batchId, SERIALS[1], proof)).to.be.revertedWithCustomError(pc, "BadStatus");
    });

    it("marks the batch exhausted once every pack is dispensed", async function () {
      const { pc, pharmacy, tree, batchId } = await loadFixture(atPharmacyFixture);
      for (const s of SERIALS) await pc.connect(pharmacy).dispense(batchId, s, tree.getProof([s]));
      const b = await pc.getBatch(batchId);
      expect(b.dispensed).to.equal(8);
      expect(b.status).to.equal(Status.Exhausted);
    });

    it("reports expired stock to the patient", async function () {
      const { pc, tree, batchId, input } = await loadFixture(atPharmacyFixture);
      await time.increaseTo(input.expiry + 10);
      expect((await pc.verifyPack(batchId, SERIALS[0], tree.getProof([SERIALS[0]]))).verdict).to.equal(Verdict.Expired);
    });
  });
});
