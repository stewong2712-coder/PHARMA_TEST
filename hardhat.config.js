require("@nomicfoundation/hardhat-toolbox");
const { subtask, vars } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
const path = require("path");

// Use the solc-js compiler from npm (works offline / behind restrictive proxies).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: require("solc/package.json").version,
    };
  }
  return runSuper();
});

// Your MetaMask TEST wallet's private key is stored outside this project folder with:
//   npx hardhat vars set SEPOLIA_PRIVATE_KEY
// so it can never be uploaded to GitHub by mistake.
const sepoliaAccounts = vars.has("SEPOLIA_PRIVATE_KEY") ? [vars.get("SEPOLIA_PRIVATE_KEY")] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: {
    sepolia: {
      url: vars.get("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
      chainId: 11155111,
      accounts: sepoliaAccounts,
    },
  },
  gasReporter: { enabled: true, noColors: true, outputFile: "reports/gas-report.txt", currency: "USD", offline: true },
};
