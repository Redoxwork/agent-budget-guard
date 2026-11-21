require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.30",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: PK,
    },
    unichainSepolia: {
      url: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
      chainId: 1301,
      accounts: PK,
    },
    lasna: {
      url: process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/",
      chainId: 5318007,
      accounts: PK,
    },
  },
};
