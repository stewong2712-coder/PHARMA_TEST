/**
 * Deploys PharmaChain to a live network (Sepolia) and prepares the public demo.
 *
 *   npx hardhat run scripts/deploy-live.js --network sepolia
 *
 * What it does:
 *   1. Checks your wallet has enough test ETH for everything below.
 *   2. Deploys the contract. Your MetaMask account becomes the administrator.
 *   3. Creates six DEMO wallets (regulator, manufacturer, distributor, pharmacy,
 *      IoT gateway, QA inspector), sends each a little test ETH and grants roles.
 *   4. Runs a short story on the real chain: two insulin batches, signed
 *      temperature readings, one batch quarantined, one pack dispensed.
 *   5. Writes web/deployment.js so web/live.html can talk to the contract.
 *
 * The demo wallets' private keys are written into web/deployment.js on purpose,
 * so anyone opening the public page can act as each organisation without
 * installing a wallet. They only ever hold small amounts of TEST ETH.
 * Your own MetaMask key is NEVER written anywhere by this script.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { cidOf, encryptForConsortium } = require("../offchain/ipfs");

const { ethers } = hre;
const GTIN = "05099999000013";
const QTY = 100;
const serialsFor = (n) => Array.from({ length: n }, (_, i) => `SN${String(i + 1).padStart(4, "0")}`);

// Gas each demo wallet is funded for (seeding + headroom for visitors to try things).
const BUDGET = { regulator: 200_000, manufacturer: 2_000_000, distributor: 1_200_000, pharmacy: 600_000, oracle: 1_500_000, inspector: 200_000 };
const ROLE_OF = { regulator: "REGULATOR_ROLE", manufacturer: "MANUFACTURER_ROLE", distributor: "DISTRIBUTOR_ROLE", pharmacy: "PHARMACY_ROLE", oracle: "ORACLE_ROLE", inspector: "INSPECTOR_ROLE" };
const ORG = {
  regulator: "National Medicines Regulator (fictional)",
  manufacturer: "Lumora Biologics Ltd (fictional)",
  distributor: "ColdRoute Distribution (fictional)",
  pharmacy: "Westside Community Pharmacy (fictional)",
  oracle: "IoT oracle gateway",
  inspector: "Independent QA Services (fictional)",
};

const fmt = (wei) => `${Number(ethers.formatEther(wei)).toFixed(5)} ETH`;
let step = 0;
const log = (msg) => console.log(`[${String(++step).padStart(2, "0")}] ${msg}`);

async function send(label, txPromise) {
  const tx = await txPromise;
  const rc = await tx.wait();
  log(`${label}  (tx ${tx.hash.slice(0, 12)}…, gas ${rc.gasUsed})`);
  return rc;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer key. Run:  npx hardhat vars set SEPOLIA_PRIVATE_KEY  and paste your MetaMask test account's private key.");
  }
  const admin = signers[0];
  const balance = await ethers.provider.getBalance(admin.address);
  const fee = await ethers.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  const fundingPrice = (price * 3n) / 2n; // 50% headroom on today's gas price for the demo wallets

  const fundTotal = Object.values(BUDGET).reduce((s, g) => s + BigInt(g), 0n) * fundingPrice;
  const adminGas = 3_200_000n; // deploy + role grants + transfers
  const needed = fundTotal + adminGas * price;

  console.log(`\nNetwork:        ${hre.network.name} (chain ${net.chainId})`);
  console.log(`Your account:   ${admin.address}`);
  console.log(`Balance:        ${fmt(balance)}`);
  console.log(`Gas price now:  ${ethers.formatUnits(price, "gwei")} gwei`);
  console.log(`Estimated need: ${fmt(needed)}\n`);
  if (balance < needed) {
    throw new Error(`Not enough test ETH. Get at least ${fmt(needed - balance)} more from a faucet, then run this again.`);
  }

  // ---- 1. Deploy --------------------------------------------------------------
  const Factory = await ethers.getContractFactory("PharmaChain", admin);
  const pc = await Factory.deploy(admin.address);
  const deployTx = pc.deploymentTransaction();
  const deployRc = await deployTx.wait();
  const address = await pc.getAddress();
  log(`Contract deployed at ${address} (block ${deployRc.blockNumber})`);

  // ---- 2. Demo wallets, funding and roles ------------------------------------
  const wallets = {};
  for (const role of Object.keys(BUDGET)) wallets[role] = ethers.Wallet.createRandom().connect(ethers.provider);
  for (const [role, w] of Object.entries(wallets)) {
    await send(`Funded ${role} wallet ${w.address.slice(0, 10)}… with ${fmt(BigInt(BUDGET[role]) * fundingPrice)}`,
      admin.sendTransaction({ to: w.address, value: BigInt(BUDGET[role]) * fundingPrice }));
  }
  for (const [role, w] of Object.entries(wallets)) {
    await send(`Granted ${ROLE_OF[role]} to ${role}`, pc.connect(admin).grantRole(await pc[ROLE_OF[role]](), w.address));
  }
  const as = (role) => pc.connect(wallets[role]);

  // ---- 3. Two batches -----------------------------------------------------------
  const tree = StandardMerkleTree.of(serialsFor(QTY).map((s) => [s]), ["string"]);
  const coa = Buffer.from(JSON.stringify({ doc: "Certificate of Analysis", product: "Insulin glargine 100 U/mL pen", potency: "99.1%", sterility: "Pass" }));
  const docsCid = await cidOf(encryptForConsortium(coa).payload);
  const latest = await ethers.provider.getBlock("latest");
  const base = {
    gtin: GTIN, expiry: latest.timestamp + 540 * 86400, quantity: QTY, minTempDeci: 20, maxTempDeci: 80,
    excursionToleranceSec: 1800, serialRoot: tree.root, docsCid,
  };
  const lots = { good: "INS-2026-0412", bad: "INS-2026-0413" };
  for (const lot of Object.values(lots)) await send(`Manufacturer registered batch ${lot} (${QTY} packs)`, as("manufacturer").createBatch({ ...base, lot }));
  const ids = { good: await pc.batchIdOf(GTIN, lots.good), bad: await pc.batchIdOf(GTIN, lots.bad) };

  // ---- 4. Loggers, shipping, signed telemetry -----------------------------------
  const loggers = { good: ethers.Wallet.createRandom(), bad: ethers.Wallet.createRandom() };
  for (const k of ["good", "bad"]) {
    await send(`Logger bound to ${lots[k]}`, as("manufacturer").bindSensor(ids[k], loggers[k].address));
    await send(`${lots[k]} shipped to distributor`, as("manufacturer").initiateTransfer(ids[k], wallets.distributor.address, ethers.id(`T3|${lots[k]}|M->D`)));
  }
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const plan = {
    good: [[48, 55], [50, 58], [52, 91], [47, 54]], // one 15-minute spike to 9.1 C (within tolerance)
    bad: [[49, 56], [62, 104], [101, 134], [96, 121]], // refrigeration failure: 45 minutes out of range
  };
  for (const k of ["good", "bad"]) {
    for (let i = 0; i < 4; i++) {
      const t = {
        batchId: ids[k], windowStart: now - 3600 + i * 900, windowEnd: now - 2700 + i * 900,
        minTempDeci: plan[k][i][0], maxTempDeci: plan[k][i][1], readingsRoot: ethers.id(`${lots[k]}-window-${i + 1}`), nonce: i + 1,
      };
      const sig = await loggers[k].signMessage(ethers.getBytes(await pc.telemetryDigest(t)));
      await send(`${lots[k]} window ${i + 1}: ${plan[k][i][0] / 10}-${plan[k][i][1] / 10} C`, as("oracle").recordTelemetry(t, sig));
    }
  }

  // ---- 5. Good batch reaches the pharmacy; one pack dispensed -----------------
  await send(`Distributor accepted ${lots.good}`, as("distributor").acceptTransfer(ids.good));
  await send(`${lots.good} shipped to pharmacy`, as("distributor").initiateTransfer(ids.good, wallets.pharmacy.address, ethers.id(`T3|${lots.good}|D->P`)));
  await send(`Pharmacy accepted ${lots.good}`, as("pharmacy").acceptTransfer(ids.good));
  await send(`Pharmacy dispensed SN0042`, as("pharmacy").dispense(ids.good, "SN0042", tree.getProof(["SN0042"])));

  const statusBad = (await pc.getBatch(ids.bad)).status;
  log(`${lots.bad} status on-chain: ${["None", "Manufactured", "InTransit", "Received", "Quarantined", "Recalled", "Exhausted"][Number(statusBad)]}`);

  // ---- 6. Write the page configuration ----------------------------------------
  const abi = JSON.parse(pc.interface.formatJson());
  const explorer = Number(net.chainId) === 11155111 ? "https://sepolia.etherscan.io" : null;
  const deployment = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    contract: address,
    deployBlock: deployRc.blockNumber,
    deployTx: deployTx.hash,
    deployedAt: new Date().toISOString(),
    admin: admin.address,
    explorer,
    rpcUrls: hre.network.name === "sepolia"
      ? ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org", "https://1rpc.io/sepolia"]
      : ["http://127.0.0.1:8545"],
    gtin: GTIN,
    serialScheme: "SN0001 to SN<quantity>, 4 digits",
    demoWallets: Object.fromEntries(Object.entries(wallets).map(([role, w]) => [role, { org: ORG[role], address: w.address, privateKey: w.privateKey }])),
    abi,
  };
  const outJs = path.join(__dirname, "..", "web", "deployment.js");
  fs.writeFileSync(outJs,
    "// Generated by scripts/deploy-live.js. TEST NETWORK ONLY: the demo wallet keys below hold test ETH, never real money.\n" +
    `window.PHARMACHAIN_DEPLOYMENT = ${JSON.stringify(deployment, null, 2)};\n`);
  fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
  const { abi: _omit, demoWallets, ...summary } = deployment;
  fs.writeFileSync(path.join(__dirname, "..", "reports", `deployment-${hre.network.name}.json`),
    JSON.stringify({ ...summary, demoWallets: Object.fromEntries(Object.entries(demoWallets).map(([r, w]) => [r, w.address])) }, null, 2));

  const left = await ethers.provider.getBalance(admin.address);
  console.log(`\nDone. Contract: ${address}`);
  if (explorer) console.log(`View it:        ${explorer}/address/${address}`);
  console.log(`Page config:    web/deployment.js (open web/live.html)`);
  console.log(`Your balance:   ${fmt(left)}\n`);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.shortMessage || e.message}\n`);
  process.exit(1);
});
