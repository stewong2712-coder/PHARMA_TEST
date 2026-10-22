/**
 * Sends more test ETH to the demo wallets used by web/live.html.
 *
 *   npx hardhat run scripts/topup-live.js --network sepolia
 *
 * Use it if the live page says a demo wallet has run out of test ETH.
 * Each wallet is topped up to the target below (in ETH); wallets already above it are skipped.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TARGET = { regulator: "0.001", manufacturer: "0.006", distributor: "0.004", pharmacy: "0.002", oracle: "0.005", inspector: "0.001" };

async function main() {
  const { ethers } = hre;
  const file = path.join(__dirname, "..", "web", "deployment.js");
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox);
  const D = sandbox.window.PHARMACHAIN_DEPLOYMENT;
  const [admin] = await ethers.getSigners();
  console.log(`Your balance: ${ethers.formatEther(await ethers.provider.getBalance(admin.address))} ETH\n`);
  for (const [role, w] of Object.entries(D.demoWallets)) {
    const have = await ethers.provider.getBalance(w.address);
    const want = ethers.parseEther(TARGET[role] || "0.002");
    if (have >= want) { console.log(`${role.padEnd(13)} ok (${ethers.formatEther(have)} ETH)`); continue; }
    const tx = await admin.sendTransaction({ to: w.address, value: want - have });
    await tx.wait();
    console.log(`${role.padEnd(13)} topped up to ${TARGET[role]} ETH (tx ${tx.hash.slice(0, 12)}…)`);
  }
}
main().catch((e) => { console.error(`ERROR: ${e.shortMessage || e.message}`); process.exit(1); });
