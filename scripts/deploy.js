// Deploys PharmaChain to the network given by --network and grants demo roles.
const { ethers } = require("hardhat");

async function main() {
  const s = await ethers.getSigners();
  // Use six different accounts when available; otherwise reuse the first (e.g. on Besu with one key)
  const [regulator, manufacturer, distributor, pharmacy, gateway, inspector] = [0, 1, 2, 3, 4, 5].map((i) => s[i] ?? s[0]);
  const pc = await (await ethers.getContractFactory("PharmaChain")).deploy(regulator.address);
  await pc.waitForDeployment();
  const roles = [
    ["MANUFACTURER_ROLE", manufacturer], ["DISTRIBUTOR_ROLE", distributor], ["PHARMACY_ROLE", pharmacy],
    ["ORACLE_ROLE", gateway], ["INSPECTOR_ROLE", inspector],
  ];
  for (const [name, acct] of roles) await (await pc.grantRole(await pc[name](), acct.address)).wait();
  console.log("PharmaChain deployed at", await pc.getAddress());
  for (const [name, acct] of roles) console.log(name.padEnd(18), acct.address);
}
main().catch((e) => { console.error(e); process.exit(1); });
