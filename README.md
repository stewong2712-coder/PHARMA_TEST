# PharmaChain — blockchain cold-chain and authenticity tracking

Prototype for the *Blockchain Foundations and Applications* assignment (Part B).
A batch of a temperature-sensitive medicine is tracked Manufacturer → Distributor →
Pharmacy → Patient on a permissioned EVM chain (Hyperledger Besu, QBFT consensus),
with documents on IPFS and signed IoT telemetry as the oracle. All organisation
names used in the simulation are fictional.

## Layout
| Path | What it is |
| --- | --- |
| `contracts/PharmaChain.sol` | Smart contract: roles, batch registry, two-step custody hand-over, signed-telemetry oracle with auto-quarantine, recall, Merkle-proof dispensing and public `verifyPack` |
| `test/PharmaChain.test.js` | 15 unit tests (access control, custody, oracle forgery/replay, quarantine, recall, counterfeit detection, expiry) |
| `oracle/gateway.js` | IoT gateway: windows raw readings, Merkle-roots them, obtains the data-logger's signature, submits |
| `offchain/ipfs.js` | CIDv1 computation, AES-256-GCM encryption for confidential documents, integrity-checked pin store |
| `scripts/simulate.js` | End-to-end run with two batches (one passes, one is auto-quarantined); writes `reports/simulation.json` |
| `scripts/deploy-live.js` | Deploys to the Sepolia test network, creates funded demo wallets, runs a short story on-chain and writes `web/deployment.js` |
| `scripts/topup-live.js` | Refills the demo wallets with test ETH |
| `web/live.html` | Live page: reads and writes the deployed contract on Sepolia (needs `web/deployment.js`) |
| `network/qbft-genesis.example.json` | Example Besu QBFT genesis for a 7-validator consortium |
| `reports/` | Gas report and simulation output |

## Run
```bash
npm install --legacy-peer-deps
npm test           # compiles and runs 15 tests + gas report
npm run simulate   # end-to-end scenario -> reports/simulation.json
```
Solidity 0.8.24 (solc-js from npm), OpenZeppelin Contracts 5.x, Hardhat 2.x, ethers 6.

## Deploying to a consortium network
1. Generate validator keys and genesis with `besu operator generate-blockchain-config` using `network/qbft-genesis.example.json` as the template.
2. Start one Besu node per consortium member with QBFT and node permissioning enabled.
3. Add a `networks.consortium` entry to `hardhat.config.js` (RPC URL + deployer key held by the regulator) and run a deploy script; the regulator then grants roles to member addresses.

## Live deployment (Sepolia test network)
```bash
npx hardhat vars set SEPOLIA_PRIVATE_KEY <your MetaMask TEST account private key>
npx hardhat run scripts/deploy-live.js --network sepolia
```
Then open `web/live.html`, or publish the `web` folder (for example with GitHub Pages).
The demo wallet keys in `web/deployment.js` are public by design and only hold test ETH.
