// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title PharmaChain
 * @notice Batch-level custody, cold-chain and authenticity ledger for
 *         temperature-sensitive medicines (Manufacturer -> Distributor ->
 *         Pharmacy -> Patient). Heavy documents live off-chain on IPFS; only
 *         their content identifiers (CIDs) and hashes are anchored here.
 *
 * Design notes
 *  - Permissioned writes (role-based) on a consortium EVM chain running
 *    QBFT/IBFT 2.0 (Proof of Authority family); reads are public so any
 *    patient can verify a pack without an account.
 *  - Custody changes use a two-step handshake (initiate -> accept) so neither
 *    party can claim a hand-over the other did not sign.
 *  - IoT telemetry arrives as signed, windowed summaries. The contract checks
 *    the device signature (ECDSA), a strictly increasing nonce (replay
 *    protection) and the batch's temperature range, and auto-quarantines the
 *    batch once cumulative excursion time exceeds the product's tolerance.
 *  - Unit serial numbers are committed as a Merkle root, so millions of packs
 *    cost one 32-byte write; a pack is proven with a Merkle proof.
 */
contract PharmaChain is AccessControl {
    using ECDSA for bytes32;

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant PHARMACY_ROLE = keccak256("PHARMACY_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant INSPECTOR_ROLE = keccak256("INSPECTOR_ROLE");

    // ------------------------------------------------------------------
    // Data model
    // ------------------------------------------------------------------
    enum Status {
        None,
        Manufactured,
        InTransit,
        Received,
        Quarantined,
        Recalled,
        Exhausted
    }

    struct BatchInput {
        string gtin; // GS1 Global Trade Item Number
        string lot; // lot / batch number
        uint64 expiry; // unix seconds
        uint32 quantity; // number of saleable packs
        int16 minTempDeci; // min storage temperature, tenths of a degree C (e.g. 20 = 2.0C)
        int16 maxTempDeci; // max storage temperature, tenths of a degree C (e.g. 80 = 8.0C)
        uint32 excursionToleranceSec; // cumulative out-of-range time allowed
        bytes32 serialRoot; // Merkle root of unit serial numbers
        string docsCid; // IPFS CID of certificate of analysis + batch record bundle
    }

    struct Batch {
        string gtin;
        string lot;
        uint64 expiry;
        uint32 quantity;
        uint32 dispensed;
        int16 minTempDeci;
        int16 maxTempDeci;
        uint32 excursionToleranceSec;
        uint32 excursionSec;
        bytes32 serialRoot;
        string docsCid;
        address manufacturer;
        address custodian;
        address pendingCustodian;
        bytes32 pendingDocHash;
        Status status;
        uint64 createdAt;
    }

    struct Telemetry {
        bytes32 batchId;
        uint64 windowStart;
        uint64 windowEnd;
        int16 minTempDeci;
        int16 maxTempDeci;
        bytes32 readingsRoot; // Merkle root of the raw readings kept off-chain
        uint64 nonce;
    }

    struct CustodyEvent {
        address from;
        address to;
        uint64 at;
        bytes32 handoverDocHash; // hash of the signed transaction statement (DSCSA T3) on IPFS
    }

    mapping(bytes32 => Batch) private batches;
    mapping(bytes32 => CustodyEvent[]) private custodyLog;
    mapping(bytes32 => mapping(bytes32 => bool)) public serialDispensed; // batchId => serialLeaf => used
    mapping(address => bytes32) public sensorBatch; // device key => batch it is bound to
    mapping(address => uint64) public sensorNonce; // device key => last accepted nonce
    mapping(bytes32 => uint64) public lastTelemetryEnd; // batchId => end of last accepted window (gap detection)
    bytes32[] private batchIds;

    // ------------------------------------------------------------------
    // Events (the off-chain indexer and the UIs are driven by these)
    // ------------------------------------------------------------------
    event BatchCreated(bytes32 indexed batchId, address indexed manufacturer, string gtin, string lot, uint32 quantity, string docsCid);
    event TransferInitiated(bytes32 indexed batchId, address indexed from, address indexed to, bytes32 handoverDocHash);
    event TransferAccepted(bytes32 indexed batchId, address indexed from, address indexed to);
    event TransferCancelled(bytes32 indexed batchId, address indexed by);
    event SensorBound(bytes32 indexed batchId, address indexed sensor);
    event TelemetryRecorded(bytes32 indexed batchId, address indexed sensor, uint64 windowStart, uint64 windowEnd, int16 minTempDeci, int16 maxTempDeci, bytes32 readingsRoot);
    event TemperatureExcursion(bytes32 indexed batchId, uint32 addedSec, uint32 totalSec);
    event BatchQuarantined(bytes32 indexed batchId, string reason);
    event BatchReleased(bytes32 indexed batchId, address indexed inspector, string assessmentCid);
    event BatchRecalled(bytes32 indexed batchId, address indexed by, string reason);
    event UnitDispensed(bytes32 indexed batchId, bytes32 indexed serialLeaf, address indexed pharmacy);
    event DocumentAttached(bytes32 indexed batchId, string cid, string docType);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error BatchExists();
    error UnknownBatch();
    error InvalidInput();
    error NotCustodian();
    error NotPendingCustodian();
    error InvalidRecipient();
    error BadStatus(Status current);
    error Expired();
    error SensorNotBound();
    error StaleNonce();
    error BadWindow();
    error InvalidProof();
    error AlreadyDispensed();

    constructor(address regulator) {
        _grantRole(DEFAULT_ADMIN_ROLE, regulator);
        _grantRole(REGULATOR_ROLE, regulator);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function batchIdOf(string calldata gtin, string calldata lot) public pure returns (bytes32) {
        return keccak256(abi.encode(gtin, lot));
    }

    function _batch(bytes32 batchId) internal view returns (Batch storage b) {
        b = batches[batchId];
        if (b.status == Status.None) revert UnknownBatch();
    }

    // ------------------------------------------------------------------
    // 1. Manufacture
    // ------------------------------------------------------------------
    function createBatch(BatchInput calldata input) external onlyRole(MANUFACTURER_ROLE) returns (bytes32 batchId) {
        if (input.quantity == 0 || input.expiry <= block.timestamp || input.minTempDeci >= input.maxTempDeci || input.serialRoot == bytes32(0)) {
            revert InvalidInput();
        }
        batchId = keccak256(abi.encode(input.gtin, input.lot));
        if (batches[batchId].status != Status.None) revert BatchExists();

        Batch storage b = batches[batchId];
        b.gtin = input.gtin;
        b.lot = input.lot;
        b.expiry = input.expiry;
        b.quantity = input.quantity;
        b.minTempDeci = input.minTempDeci;
        b.maxTempDeci = input.maxTempDeci;
        b.excursionToleranceSec = input.excursionToleranceSec;
        b.serialRoot = input.serialRoot;
        b.docsCid = input.docsCid;
        b.manufacturer = msg.sender;
        b.custodian = msg.sender;
        b.status = Status.Manufactured;
        b.createdAt = uint64(block.timestamp);
        batchIds.push(batchId);

        custodyLog[batchId].push(CustodyEvent(address(0), msg.sender, uint64(block.timestamp), bytes32(0)));
        emit BatchCreated(batchId, msg.sender, input.gtin, input.lot, input.quantity, input.docsCid);
    }

    // ------------------------------------------------------------------
    // 2. Custody hand-over (two-step handshake)
    // ------------------------------------------------------------------
    function initiateTransfer(bytes32 batchId, address to, bytes32 handoverDocHash) external {
        Batch storage b = _batch(batchId);
        if (b.custodian != msg.sender) revert NotCustodian();
        if (b.status != Status.Manufactured && b.status != Status.Received) revert BadStatus(b.status);
        if (block.timestamp >= b.expiry) revert Expired();
        if (!_isValidNextHolder(msg.sender, to)) revert InvalidRecipient();

        b.pendingCustodian = to;
        b.pendingDocHash = handoverDocHash;
        b.status = Status.InTransit;
        emit TransferInitiated(batchId, msg.sender, to, handoverDocHash);
    }

    function acceptTransfer(bytes32 batchId) external {
        Batch storage b = _batch(batchId);
        if (b.status != Status.InTransit) revert BadStatus(b.status);
        if (b.pendingCustodian != msg.sender) revert NotPendingCustodian();

        address from = b.custodian;
        b.custodian = msg.sender;
        b.pendingCustodian = address(0);
        b.status = Status.Received;
        custodyLog[batchId].push(CustodyEvent(from, msg.sender, uint64(block.timestamp), b.pendingDocHash));
        b.pendingDocHash = bytes32(0);
        emit TransferAccepted(batchId, from, msg.sender);
    }

    /// @notice Sender can withdraw an un-accepted hand-over (e.g. wrong consignee).
    function cancelTransfer(bytes32 batchId) external {
        Batch storage b = _batch(batchId);
        if (b.status != Status.InTransit) revert BadStatus(b.status);
        if (b.custodian != msg.sender) revert NotCustodian();
        b.pendingCustodian = address(0);
        b.pendingDocHash = bytes32(0);
        b.status = b.custodian == b.manufacturer ? Status.Manufactured : Status.Received;
        emit TransferCancelled(batchId, msg.sender);
    }

    /// Manufacturer -> Distributor; Distributor -> Distributor or Pharmacy.
    function _isValidNextHolder(address from, address to) internal view returns (bool) {
        if (to == address(0) || to == from) return false;
        if (hasRole(MANUFACTURER_ROLE, from)) return hasRole(DISTRIBUTOR_ROLE, to);
        if (hasRole(DISTRIBUTOR_ROLE, from)) return hasRole(DISTRIBUTOR_ROLE, to) || hasRole(PHARMACY_ROLE, to);
        return false;
    }

    // ------------------------------------------------------------------
    // 3. Cold-chain oracle
    // ------------------------------------------------------------------
    /// Custodian or regulator binds a data-logger's public key to a batch.
    function bindSensor(bytes32 batchId, address sensor) external {
        Batch storage b = _batch(batchId);
        if (b.custodian != msg.sender && !hasRole(REGULATOR_ROLE, msg.sender)) revert NotCustodian();
        if (sensor == address(0)) revert InvalidInput();
        sensorBatch[sensor] = batchId;
        emit SensorBound(batchId, sensor);
    }

    /// Digest the sensor signs (EIP-191 personal_sign over this hash).
    function telemetryDigest(Telemetry calldata t) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), t.batchId, t.windowStart, t.windowEnd, t.minTempDeci, t.maxTempDeci, t.readingsRoot, t.nonce)
        );
    }

    /**
     * @notice Called by an authorised IoT gateway (ORACLE_ROLE). The payload
     *         must carry a valid signature from the data-logger bound to the
     *         batch, so a compromised gateway cannot invent readings.
     */
    function recordTelemetry(Telemetry calldata t, bytes calldata sensorSig) external onlyRole(ORACLE_ROLE) {
        Batch storage b = _batch(t.batchId);
        if (t.windowEnd <= t.windowStart || t.windowEnd > block.timestamp + 300 || t.minTempDeci > t.maxTempDeci) revert BadWindow();

        address sensor = MessageHashUtils.toEthSignedMessageHash(telemetryDigest(t)).recover(sensorSig);
        if (sensorBatch[sensor] != t.batchId) revert SensorNotBound();
        if (t.nonce <= sensorNonce[sensor]) revert StaleNonce();
        sensorNonce[sensor] = t.nonce;
        if (t.windowEnd > lastTelemetryEnd[t.batchId]) lastTelemetryEnd[t.batchId] = t.windowEnd;

        emit TelemetryRecorded(t.batchId, sensor, t.windowStart, t.windowEnd, t.minTempDeci, t.maxTempDeci, t.readingsRoot);

        if (t.minTempDeci < b.minTempDeci || t.maxTempDeci > b.maxTempDeci) {
            uint32 added = uint32(t.windowEnd - t.windowStart);
            b.excursionSec += added;
            emit TemperatureExcursion(t.batchId, added, b.excursionSec);
            if (b.excursionSec > b.excursionToleranceSec && b.status != Status.Quarantined && b.status != Status.Recalled) {
                b.status = Status.Quarantined;
                b.pendingCustodian = address(0);
                emit BatchQuarantined(t.batchId, "Cumulative temperature excursion exceeded tolerance");
            }
        }
    }

    // ------------------------------------------------------------------
    // 4. Quality decisions
    // ------------------------------------------------------------------
    /// QA inspector releases a quarantined batch after a stability assessment.
    function releaseFromQuarantine(bytes32 batchId, string calldata assessmentCid) external onlyRole(INSPECTOR_ROLE) {
        Batch storage b = _batch(batchId);
        if (b.status != Status.Quarantined) revert BadStatus(b.status);
        b.status = Status.Received;
        b.excursionSec = 0;
        emit BatchReleased(batchId, msg.sender, assessmentCid);
        emit DocumentAttached(batchId, assessmentCid, "STABILITY_ASSESSMENT");
    }

    /// Inspector can also quarantine on a physical inspection finding.
    function quarantine(bytes32 batchId, string calldata reason) external onlyRole(INSPECTOR_ROLE) {
        Batch storage b = _batch(batchId);
        if (b.status == Status.Recalled || b.status == Status.Quarantined) revert BadStatus(b.status);
        b.status = Status.Quarantined;
        b.pendingCustodian = address(0);
        emit BatchQuarantined(batchId, reason);
    }

    function recall(bytes32 batchId, string calldata reason) external {
        Batch storage b = _batch(batchId);
        if (msg.sender != b.manufacturer && !hasRole(REGULATOR_ROLE, msg.sender)) revert NotCustodian();
        if (b.status == Status.Recalled) revert BadStatus(b.status);
        b.status = Status.Recalled;
        b.pendingCustodian = address(0);
        emit BatchRecalled(batchId, msg.sender, reason);
    }

    function attachDocument(bytes32 batchId, string calldata cid, string calldata docType) external {
        Batch storage b = _batch(batchId);
        if (msg.sender != b.custodian && msg.sender != b.manufacturer && !hasRole(INSPECTOR_ROLE, msg.sender)) revert NotCustodian();
        emit DocumentAttached(batchId, cid, docType);
    }

    // ------------------------------------------------------------------
    // 5. Point of dispense and patient verification
    // ------------------------------------------------------------------
    function serialLeaf(string calldata serial) public pure returns (bytes32) {
        // Double-hashed leaf, matching @openzeppelin/merkle-tree StandardMerkleTree(["string"])
        return keccak256(bytes.concat(keccak256(abi.encode(serial))));
    }

    /// Pharmacy scans the pack's 2D DataMatrix at hand-out; a serial can only be dispensed once.
    function dispense(bytes32 batchId, string calldata serial, bytes32[] calldata proof) external onlyRole(PHARMACY_ROLE) {
        Batch storage b = _batch(batchId);
        if (b.custodian != msg.sender) revert NotCustodian();
        if (b.status != Status.Received) revert BadStatus(b.status);
        if (block.timestamp >= b.expiry) revert Expired();
        bytes32 leaf = serialLeaf(serial);
        if (!MerkleProof.verifyCalldata(proof, b.serialRoot, leaf)) revert InvalidProof();
        if (serialDispensed[batchId][leaf]) revert AlreadyDispensed();

        serialDispensed[batchId][leaf] = true;
        b.dispensed += 1;
        if (b.dispensed == b.quantity) b.status = Status.Exhausted;
        emit UnitDispensed(batchId, leaf, msg.sender);
    }

    enum Verdict {
        Genuine,
        GenuineAlreadyDispensed,
        UnknownSerial,
        UnknownBatch,
        Recalled,
        Quarantined,
        Expired
    }

    /// Public, gas-free read used by the patient app after scanning the QR/NFC tag.
    function verifyPack(bytes32 batchId, string calldata serial, bytes32[] calldata proof)
        external
        view
        returns (Verdict verdict, string memory gtin, string memory lot, uint64 expiry, uint32 excursionSec, address manufacturer)
    {
        Batch storage b = batches[batchId];
        if (b.status == Status.None) return (Verdict.UnknownBatch, "", "", 0, 0, address(0));
        gtin = b.gtin;
        lot = b.lot;
        expiry = b.expiry;
        excursionSec = b.excursionSec;
        manufacturer = b.manufacturer;
        bytes32 leaf = serialLeaf(serial);
        if (!MerkleProof.verifyCalldata(proof, b.serialRoot, leaf)) verdict = Verdict.UnknownSerial;
        else if (b.status == Status.Recalled) verdict = Verdict.Recalled;
        else if (b.status == Status.Quarantined) verdict = Verdict.Quarantined;
        else if (block.timestamp >= b.expiry) verdict = Verdict.Expired;
        else if (serialDispensed[batchId][leaf]) verdict = Verdict.GenuineAlreadyDispensed;
        else verdict = Verdict.Genuine;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        return _batch(batchId);
    }

    function getCustodyLog(bytes32 batchId) external view returns (CustodyEvent[] memory) {
        return custodyLog[batchId];
    }

    function batchCount() external view returns (uint256) {
        return batchIds.length;
    }

    function batchIdAt(uint256 i) external view returns (bytes32) {
        return batchIds[i];
    }
}
