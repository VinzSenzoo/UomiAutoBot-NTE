import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const RPC_URL = "https://finney.uomi.ai/";
const CONFIG_FILE = "config.json";
const SYN_ADDRESS = "0x2922B2Ca5EB6b02fc5E1EBE57Fc1972eBB99F7e0";
const WUOMI_ADDRESS = "0x5FCa78E132dF589c1c799F906dC867124a2567b2";
const SWAP_ROUTER_ADDRESS = "0x197EEAd5Fe3DB82c4Cd55C5752Bc87AEdE11f230";
const LP_MANAGER_ADDRESS = "0x906515Dc7c32ab887C8B8Dce6463ac3a7816Af38";
const CHAIN_ID = 4386;
const isDebug = false;

const swapTokens = [
  { name: "SYN", address: SYN_ADDRESS, decimals: 18 },
  { name: "WUOMI", address: WUOMI_ADDRESS, decimals: 18 }
];

let walletInfo = {
  address: "N/A",
  balanceUOMI: "0.0000",
  balanceSYN: "0.0000",
  balanceWUOMI: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let accounts = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  swapRepetitions: 1,
  uomiSwapRange: { min: 0.01, max: 0.05 },
  addLpRepetitions: 1,
  wuomiAddLpRange: { min: 0.01, max: 0.03 }
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const SWAP_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable"
];
const LP_MANAGER_ABI = [
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function factory() view returns (address)"
];
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.swapRepetitions = Number(config.swapRepetitions) || 1;
      dailyActivityConfig.uomiSwapRange.min = Number(config.uomiSwapRange?.min) || 0.01;
      dailyActivityConfig.uomiSwapRange.max = Number(config.uomiSwapRange?.max) || 0.05;
      dailyActivityConfig.addLpRepetitions = Number(config.addLpRepetitions) || 1;
      dailyActivityConfig.wuomiAddLpRange.min = Number(config.wuomiAddLpRange?.min) || 0.01;
      dailyActivityConfig.wuomiAddLpRange.max = Number(config.wuomiAddLpRange?.max) || 0.03;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeJsonRpcCall(method, params) {
  try {
    const id = uuidv4();
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const agent = createAgent(proxyUrl);
    const response = await axios.post(RPC_URL, {
      jsonrpc: "2.0",
      id,
      method,
      params
    }, {
      headers: { "Content-Type": "application/json" },
      httpsAgent: agent
    });
    const data = response.data;
    if (data.error) {
      throw new Error(`RPC Error: ${data.error.message} (code: ${data.error.code})`);
    }
    return data.result;
  } catch (error) {
    addLog(`JSON-RPC call failed (${method}): ${error.message}`, "error");
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("account.json", "utf8");
    accounts = JSON.parse(data);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("No accounts found in account.json");
    }
    accounts.forEach((account, index) => {
      if (!account.privateKey || !account.token) {
        throw new Error(`Account at index ${index} is missing privateKey or token`);
      }
    });
    addLog(`Loaded ${accounts.length} accounts from account.json`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProviderWithProxy(proxyUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const fetchOptions = agent ? { agent } : {};
      const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "Synthra" }, { fetchOptions });
      provider.getNetwork().then(network => {
        if (Number(network.chainId) !== CHAIN_ID) {
          throw new Error(`Network chain ID mismatch: expected ${CHAIN_ID}, got ${network.chainId}`);
        }
      }).catch(err => {
        throw err;
      });
      return provider;
    } catch (error) {
      addLog(`Attempt ${attempt}/${maxRetries} failed to initialize provider: ${error.message}`, "error");
      if (attempt < maxRetries) sleep(1000);
    }
  }
  try {
    addLog(`Proxy failed, falling back to direct connection`, "warn");
    const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "Synthra" });
    provider.getNetwork().then(network => {
      if (Number(network.chainId) !== CHAIN_ID) {
        throw new Error(`Network chain ID mismatch: expected ${CHAIN_ID}, got ${network.chainId}`);
      }
    }).catch(err => {
      throw err;
    });
    return provider;
  } catch (error) {
    addLog(`Fallback failed: ${error.message}`, "error");
    throw error;
  }
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = accounts.map(async (account, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const provider = getProviderWithProxy(proxyUrl);
      const wallet = new ethers.Wallet(account.privateKey, provider);

      const uomiBalance = await provider.getBalance(wallet.address);
      const formattedUOMI = Number(ethers.formatEther(uomiBalance)).toFixed(4);

      const synContract = new ethers.Contract(SYN_ADDRESS, ERC20_ABI, provider);
      const synBalance = await synContract.balanceOf(wallet.address);
      const formattedSYN = Number(ethers.formatUnits(synBalance, 18)).toFixed(4);

      const wuomiContract = new ethers.Contract(WUOMI_ADDRESS, ERC20_ABI, provider);
      const wuomiBalance = await wuomiContract.balanceOf(wallet.address);
      const formattedWUOMI = Number(ethers.formatUnits(wuomiBalance, 18)).toFixed(4);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(wallet.address))}    ${chalk.bold.cyanBright(formattedUOMI.padEnd(8))}   ${chalk.bold.cyanBright(formattedSYN.padEnd(8))}   ${chalk.bold.cyanBright(formattedWUOMI.padEnd(8))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceUOMI = formattedUOMI;
        walletInfo.balanceSYN = formattedSYN;
        walletInfo.balanceWUOMI = formattedWUOMI;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.0000 0.0000 0.0000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function getNextNonce(provider, walletAddress) {
  if (shouldStop) {
    addLog("Nonce fetch stopped due to stop request.", "info");
    throw new Error("Process stopped");
  }
  if (!ethers.isAddress(walletAddress)) {
    addLog(`Invalid wallet address: ${walletAddress}`, "error");
    throw new Error("Invalid wallet address");
  }
  try {
    const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
    const lastUsedNonce = nonceTracker[walletAddress] || pendingNonce - 1;
    const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
    nonceTracker[walletAddress] = nextNonce;
    addLog(`Debug: Fetched nonce ${nextNonce} for ${getShortAddress(walletAddress)}`, "debug");
    return nextNonce;
  } catch (error) {
    addLog(`Failed to fetch nonce for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
    throw error;
  }
}

async function performSwap(wallet, tokenOut, amount) {
  const router = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
  const amountInWei = ethers.parseUnits(amount.toString(), 18);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  const balanceRaw = await wallet.provider.getBalance(wallet.address);
  const balanceFormatted = parseFloat(ethers.formatEther(balanceRaw));
  addLog(`Balance UOMI: ${balanceFormatted}, required ${amount}`, "debug");
  if (balanceFormatted < amount) {
    throw new Error(`Insufficient UOMI: have ${balanceFormatted}, need ${amount}`);
  }

  const poolAddr = await getPoolAddress(wallet.provider);
  addLog(`Pool address: ${poolAddr}`, "debug");
  if (poolAddr === ethers.ZeroAddress) {
    throw new Error("Pool fee 3000 tidak ditemukan");
  }
  const price = await getCurrentPrice(wallet.provider, poolAddr);
  addLog(`Current price: ${price} WUOMI per SYN`, "debug");

  const estOut = amount / price;
  const amountOutMin = ethers.parseUnits((estOut * 0.95).toFixed(18), 18);
  addLog(`Estimated SYN output: ${estOut}, Min output: ${ethers.formatUnits(amountOutMin, 18)}`, "debug");

  const path = ethers.concat([
    WUOMI_ADDRESS,
    ethers.toBeHex(3000, 3),
    SYN_ADDRESS
  ]);

  const wrapEth = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"],
    ["0x0000000000000000000000000000000000000002", amountInWei]
  );

  const v3SwapExactIn = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    [
      wallet.address,
      amountInWei,
      amountOutMin,
      path,
      false
    ]
  );

  let commandsBytes = "0x0b00";

  try {
    const callData = router.interface.encodeFunctionData("execute", [
      commandsBytes,
      [wrapEth, v3SwapExactIn],
      deadline
    ]);
    await wallet.provider.call({
      to: SWAP_ROUTER_ADDRESS,
      data: callData,
      from: wallet.address,
      value: amountInWei
    });
    addLog("callStatic success with commandsBytes 0x0b00", "debug");
  } catch (err) {
    addLog(`callStatic gagal dengan 0x0b00: ${err.message}`, "error");
    if (err.data) addLog(`Error data: ${err.data}`, "error");

    commandsBytes = "0x0b";
    try {
      const altCallData = router.interface.encodeFunctionData("execute", [
        commandsBytes,
        [wrapEth, v3SwapExactIn],
        deadline
      ]);
      await wallet.provider.call({
        to: SWAP_ROUTER_ADDRESS,
        data: altCallData,
        from: wallet.address,
        value: amountInWei
      });
      addLog("callStatic success with commandsBytes 0x0b", "debug");
    } catch (altErr) {
      addLog(`callStatic gagal dengan 0x0b: ${altErr.message}`, "error");
      if (altErr.data) addLog(`Error data (0x0b): ${altErr.data}`, "error");
      throw err;
    }
  }

  try {
    const tx = await router.execute(
      commandsBytes,
      [wrapEth, v3SwapExactIn],
      deadline,
      {
        gasLimit: 750_000,
        nonce: await getNextNonce(wallet.provider, wallet.address),
        value: amountInWei
      }
    );
    addLog(`Swap Tx Sent: ${getShortHash(tx.hash)}`, "info");
    const receipt = await tx.wait();
    if (receipt.status === 0) throw new Error("Swap transaction reverted");
    addLog(`Swap Successfully ${amount} UOMI ➪ ${tokenOut.name}`, "success");
  } catch (error) {
    addLog(`Swap gagal: ${error.message}`, "error");
    throw error;
  }
}

async function getCurrentPrice(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const slot0 = await pool.slot0();
  const sqrtPriceX96 = slot0.sqrtPriceX96;
  const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return price;
}

async function getPoolAddress(provider) {
  const lpManager = new ethers.Contract(LP_MANAGER_ADDRESS, LP_MANAGER_ABI, provider);
  const factoryAddress = await lpManager.factory();
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(SYN_ADDRESS, WUOMI_ADDRESS, 3000);
  return poolAddress;
}

async function performAddLp(wallet, amountWUOMI) {
  const provider = wallet.provider;
  const poolAddress = await getPoolAddress(provider);
  const price = await getCurrentPrice(provider, poolAddress);
  const amountSYN = amountWUOMI / price;
  const amountSYNWei = ethers.parseUnits(amountSYN.toFixed(18), 18);
  const amountWUOMIWei = ethers.parseUnits(amountWUOMI.toString(), 18);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  const lpManagerContract = new ethers.Contract(LP_MANAGER_ADDRESS, LP_MANAGER_ABI, wallet);
  const synContract = new ethers.Contract(SYN_ADDRESS, ERC20_ABI, wallet);
  const wuomiContract = new ethers.Contract(WUOMI_ADDRESS, ERC20_ABI, wallet);

  try {
    const synAllowance = await synContract.allowance(wallet.address, LP_MANAGER_ADDRESS);
    if (synAllowance < amountSYNWei) {
      addLog(`Approving LP manager to spend ${amountSYN.toFixed(4)} SYN`, "info");
      const approveSynTx = await synContract.approve(LP_MANAGER_ADDRESS, amountSYNWei, {
        gasLimit: 100000,
        nonce: await getNextNonce(provider, wallet.address)
      });
      await approveSynTx.wait();
      addLog("SYN approval successful", "success");
    }

    const wuomiAllowance = await wuomiContract.allowance(wallet.address, LP_MANAGER_ADDRESS);
    if (wuomiAllowance < amountWUOMIWei) {
      addLog(`Approving LP manager to spend ${amountWUOMI} WUOMI`, "info");
      const approveWuomiTx = await wuomiContract.approve(LP_MANAGER_ADDRESS, amountWUOMIWei, {
        gasLimit: 100000,
        nonce: await getNextNonce(provider, wallet.address)
      });
      await approveWuomiTx.wait();
      addLog("WUOMI approval successful", "success");
    }

    const params = {
      token0: SYN_ADDRESS,
      token1: WUOMI_ADDRESS,
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: amountSYNWei,
      amount1Desired: amountWUOMIWei,
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: deadline
    };

    const tx = await lpManagerContract.mint(params, {
      gasLimit: 500000,
      nonce: await getNextNonce(provider, wallet.address)
    });
    addLog(`Add LP transaction sent: ${getShortHash(tx.hash)}`, "info");
    const receipt = await tx.wait();
    if (receipt.status === 0) {
      throw new Error("Transaction reverted");
    }
    addLog(`Add LP successful: ${amountSYN.toFixed(4)} SYN and ${amountWUOMI} WUOMI`, "success");
    await updateWallets();
  } catch (error) {
    addLog(`Add LP failed: ${error.message}`, "error");
    throw error;
  }
}

async function runDailyActivity() {
  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Swap: ${dailyActivityConfig.swapRepetitions}x, Auto Add LP: ${dailyActivityConfig.addLpRepetitions}x`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < accounts.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      let provider;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      try {
        provider = await getProviderWithProxy(proxyUrl);
        await provider.getNetwork();
      } catch (error) {
        addLog(`Failed to connect to provider for account ${accountIndex + 1}: ${error.message}`, "error");
        continue;
      }
      const wallet = new ethers.Wallet(accounts[accountIndex].privateKey, provider);
      if (!ethers.isAddress(wallet.address)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${wallet.address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");

      for (let swapCount = 0; swapCount < dailyActivityConfig.swapRepetitions && !shouldStop; swapCount++) {
        const tokenOut = swapTokens.find(t => t.name === "SYN");
        const amount = (Math.random() * (dailyActivityConfig.uomiSwapRange.max - dailyActivityConfig.uomiSwapRange.min) + dailyActivityConfig.uomiSwapRange.min).toFixed(4);
        addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1}: ${amount} UOMI to ${tokenOut.name}`, "info");
        try {
          await performSwap(wallet, tokenOut, amount);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1}: Failed: ${error.message}`, "error");
        }
        if (swapCount < dailyActivityConfig.swapRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next swap...`, "delay");
          await sleep(randomDelay);
        }
      }

      for (let lpCount = 0; lpCount < dailyActivityConfig.addLpRepetitions && !shouldStop; lpCount++) {
        const amountWUOMI = (Math.random() * (dailyActivityConfig.wuomiAddLpRange.max - dailyActivityConfig.wuomiAddLpRange.min) + dailyActivityConfig.wuomiAddLpRange.min).toFixed(4);
        addLog(`Account ${accountIndex + 1} - Add LP ${lpCount + 1}: ${amountWUOMI} WUOMI`, "info");
        try {
          await performAddLp(wallet, amountWUOMI);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Add LP ${lpCount + 1}: Failed: ${error.message}`, "error");
        }
        if (lpCount < dailyActivityConfig.addLpRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next add LP...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (accountIndex < accounts.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          if (dailyActivityInterval) {
            clearTimeout(dailyActivityInterval);
            dailyActivityInterval = null;
            addLog("Cleared daily activity interval.", "info");
          }
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog("Daily activity stopped successfully.", "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
        }
      }, 1000);
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
    nonceTracker = {};
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "UOMI TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "59%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Set Swap Repetitions",
    "Set UOMI Swap Range",
    "Set Add LP Repetitions",
    "Set WUOMI Add LP Range",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  statusBox.width = screenWidth - 2;
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = screenWidth - walletBox.width - 2;
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
  }

  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${accounts.length} | Auto Swap: ${dailyActivityConfig.swapRepetitions}x | Auto Add LP: ${dailyActivityConfig.addLpRepetitions}x | UOMI TESTNET AUTO BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("  Address").padEnd(12)}           ${chalk.bold.cyan("UOMI".padEnd(8))}   ${chalk.bold.cyan("SYN".padEnd(8))}   ${chalk.bold.cyan("WUOMI".padEnd(8))}`;
    const separator = chalk.gray("-".repeat(60));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity. Please wait for ongoing process to complete.", "info");
      safeRender();
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
          safeRender();
        }
      }, 1000);
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Swap Repetitions":
      configForm.configType = "swapRepetitions";
      configForm.setLabel(" Enter Swap Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.swapRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set UOMI Swap Range":
      configForm.configType = "uomiSwapRange";
      configForm.setLabel(" Enter UOMI Swap Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.uomiSwapRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.uomiSwapRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set Add LP Repetitions":
      configForm.configType = "addLpRepetitions";
      configForm.setLabel(" Enter Add LP Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.addLpRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set WUOMI Add LP Range":
      configForm.configType = "wuomiAddLpRange";
      configForm.setLabel(" Enter WUOMI Add LP Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.wuomiAddLpRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.wuomiAddLpRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

let isSubmitting = false;
configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    value = parseFloat(inputValue);
    if (["uomiSwapRange", "wuomiAddLpRange"].includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue();
        screen.focusPush(configInputMax);
        safeRender();
        isSubmitting = false;
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue();
    screen.focusPush(configInput);
    safeRender();
    isSubmitting = false;
    return;
  }

  if (configForm.configType === "swapRepetitions") {
    dailyActivityConfig.swapRepetitions = Math.floor(value);
    addLog(`Swap Repetitions set to ${dailyActivityConfig.swapRepetitions}`, "success");
  } else if (configForm.configType === "uomiSwapRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.uomiSwapRange.min = value;
    dailyActivityConfig.uomiSwapRange.max = maxValue;
    addLog(`UOMI Swap Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "addLpRepetitions") {
    dailyActivityConfig.addLpRepetitions = Math.floor(value);
    addLog(`Add LP Repetitions set to ${dailyActivityConfig.addLpRepetitions}`, "success");
  } else if (configForm.configType === "wuomiAddLpRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.wuomiAddLpRange.min = value;
    dailyActivityConfig.wuomiAddLpRange.max = maxValue;
    addLog(`WUOMI Add LP Range set to ${value} - ${maxValue}`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

configInput.key(["enter"], () => {
  if (["uomiSwapRange", "wuomiAddLpRange"].includes(configForm.configType)) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  screen.focusPush(configSubmitButton);
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadAccounts();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();