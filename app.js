/* AgentInk — frontend logic.
 *
 * Static page, no build step. Requires an injected wallet (window.ethereum,
 * e.g. MetaMask). Every sign / like is a real on-chain transaction that the
 * user must approve in their own wallet — nothing is ever auto-signed.
 *
 * CONFIG: fill in AGENT_WALL_ADDRESS after the AgentWall contract is
 * deployed. While it is empty the app runs in preview mode with 3 sample
 * messages so the UI can be reviewed without a contract.
 */

"use strict";

/* ------------------------------------------------------------------ */
/* CONFIG — edit this after deployment                                 */
/* ------------------------------------------------------------------ */
const CONFIG = {
  // AgentWall contract address on BNB Chain. Empty = not deployed yet.
  AGENT_WALL_ADDRESS: "0x890B16f7f7198b7d1c5b9410BC99D9D99EF4F9c2",
  // Agent ID contract (ERC-721) on BNB Chain — balanceOf > 0 = holder.
  AGENT_ID_ADDRESS: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
  // BNB Chain mainnet.
  BSC_CHAIN_ID: 56,
  BSC_CHAIN_ID_HEX: "0x38",
  MAX_MESSAGE_LENGTH: 280,
  // How many wall messages to load at most in one go.
  WALL_PAGE_SIZE: 50,
};

/* Minimal ABI for the AgentWall contract.
 * NOTE: names, order and types must match contracts/AgentWall.sol exactly.
 * getMessage returns (signer, message, timestamp, likes); getTopMessages
 * returns an array of message ids (uint256[]), NOT message tuples. */
const AGENT_WALL_ABI = [
  "function sign(string message)",
  "function like(uint256 messageId)",
  "function getMessageCount() view returns (uint256)",
  "function getMessage(uint256 index) view returns (address signer, string message, uint256 timestamp, uint256 likes)",
  "function getTopMessages(uint256 limit) view returns (uint256[])",
  "event MessageSigned(uint256 indexed id, address indexed signer, string message, uint256 timestamp)",
  "event Liked(uint256 indexed id, address indexed liker)",
];

const AGENT_ID_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

/* ------------------------------------------------------------------ */
/* Sample messages shown in preview mode (no contract deployed yet)    */
/* ------------------------------------------------------------------ */
const PREVIEW_MESSAGES = [
  {
    id: 2,
    author: "0xF8A3346Cc697e010B5313B4947f2Dce4679b3897",
    text: "Hello from the AgentInk. This is a preview message — the contract is not deployed yet, so these three messages are local samples.",
    likes: 12,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
  },
  {
    id: 1,
    author: "0x3a7d4E5f9b2C1a8D6e0F1234567890abcdef1234",
    text: "Only Agent ID holders can sign here. Everyone can read the wall.",
    likes: 7,
    timestamp: Math.floor(Date.now() / 1000) - 7200,
  },
  {
    id: 0,
    author: "0x9b1C2d3E4f5A6b7C8d9E0f1A2b3C4d5E6f7A8b9c",
    text: "First message on the wall. Messages are public and permanent — think before you sign.",
    likes: 3,
    timestamp: Math.floor(Date.now() / 1000) - 14400,
  },
];

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
let provider = null;
let signer = null;
let account = null;
let isHolder = false;
let onCorrectChain = false;
let wallContract = null;
/* Message ids the user has liked in this session (local cache only —
 * the contract is the source of truth and will revert a second like). */
const likedIds = new Set();

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const els = {
  connectBtn: $("connectBtn"),
  switchChainBtn: $("switchChainBtn"),
  walletStatus: $("walletStatus"),
  agentIdStatus: $("agentIdStatus"),
  agentIdDetail: $("agentIdDetail"),
  notice: $("notice"),
  messageInput: $("messageInput"),
  charCount: $("charCount"),
  signBtn: $("signBtn"),
  composeHint: $("composeHint"),
  wall: $("wall"),
  wallEmpty: $("wallEmpty"),
  wallMeta: $("wallMeta"),
  wallContractLabel: $("wallContractLabel"),
};

function showNotice(text, kind) {
  // kind: "info" | "warn" | "error". Empty text hides the notice.
  if (!text) {
    els.notice.style.display = "none";
    els.notice.textContent = "";
    els.notice.className = "";
    return;
  }
  els.notice.textContent = text;
  els.notice.className = kind === "error" ? "error" : kind === "warn" ? "" : "info";
  els.notice.style.display = "block";
}

function shortenAddress(address) {
  if (!address) return "";
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(unixSeconds) {
  if (!unixSeconds) return "";
  try {
    return new Date(Number(unixSeconds) * 1000).toLocaleString();
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */
function hasInjectedWallet() {
  return typeof window.ethereum !== "undefined";
}

async function connectWallet() {
  if (!hasInjectedWallet()) {
    showNotice(
      "No wallet found. Install an injected wallet such as MetaMask, then reload this page and try again.",
      "error"
    );
    return;
  }
  try {
    showNotice("Waiting for your wallet… please approve the connection request.", "info");
    provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_requestAccounts", []);
    if (!accounts || accounts.length === 0) {
      showNotice("No account was connected. Try again and select an account in your wallet.", "error");
      return;
    }
    account = accounts[0];
    signer = await provider.getSigner();
    wireWalletEvents();
    await refreshChainState();
    await refreshAccountState();
    showNotice("", "info");
  } catch (err) {
    showNotice(friendlyError(err, "Could not connect the wallet."), "error");
  }
}

function wireWalletEvents() {
  if (!window.ethereum || window.ethereum._agentWallWired) return;
  window.ethereum._agentWallWired = true;
  window.ethereum.on("accountsChanged", (accounts) => {
    account = accounts && accounts.length ? accounts[0] : null;
    refreshAccountState();
  });
  window.ethereum.on("chainChanged", () => {
    // Chain changed: re-check everything (provider caches the network).
    provider = new ethers.BrowserProvider(window.ethereum);
    refreshChainState().then(refreshAccountState);
  });
}

async function refreshChainState() {
  try {
    const network = await provider.getNetwork();
    onCorrectChain = Number(network.chainId) === CONFIG.BSC_CHAIN_ID;
  } catch {
    onCorrectChain = false;
  }
  els.switchChainBtn.hidden = onCorrectChain;
  if (account && !onCorrectChain) {
    showNotice(
      "You are on the wrong network. AgentInk runs on BNB Chain (chain ID 56). Use the “Switch to BNB Chain” button — your wallet will ask you to confirm the switch.",
      "warn"
    );
  }
  return onCorrectChain;
}

async function switchToBsc() {
  if (!hasInjectedWallet()) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CONFIG.BSC_CHAIN_ID_HEX }],
    });
    await refreshChainState();
    await refreshAccountState();
    if (onCorrectChain) showNotice("", "info");
  } catch (err) {
    // 4902 = chain not added to the wallet yet → add it, then switch.
    if (err && err.code === 4902) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CONFIG.BSC_CHAIN_ID_HEX,
              chainName: "BNB Chain",
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: ["https://bsc-dataseed.binance.org"],
              blockExplorerUrls: ["https://bscscan.com"],
            },
          ],
        });
        await refreshChainState();
        await refreshAccountState();
      } catch (addErr) {
        showNotice(friendlyError(addErr, "Could not add BNB Chain to your wallet."), "error");
      }
    } else {
      showNotice(friendlyError(err, "Could not switch networks."), "error");
    }
  }
}

async function refreshAccountState() {
  if (!account) {
    els.walletStatus.textContent = "Not connected";
    els.agentIdStatus.textContent = "Not checked";
    els.agentIdStatus.className = "badge warn";
    els.agentIdDetail.textContent = "";
    isHolder = false;
    updateComposeState();
    return;
  }

  els.walletStatus.innerHTML =
    'Connected: <span class="addr">' + escapeHtml(shortenAddress(account)) + "</span>";

  if (!onCorrectChain) {
    els.agentIdStatus.textContent = "Not checked";
    els.agentIdStatus.className = "badge warn";
    els.agentIdDetail.textContent = " — switch to BNB Chain first.";
    isHolder = false;
    updateComposeState();
    return;
  }

  // Check Agent ID ownership via balanceOf on the Agent ID contract.
  els.agentIdStatus.textContent = "Checking…";
  els.agentIdStatus.className = "badge warn";
  try {
    const agentId = new ethers.Contract(CONFIG.AGENT_ID_ADDRESS, AGENT_ID_ABI, provider);
    const balance = await agentId.balanceOf(account);
    isHolder = balance > 0n;
    if (isHolder) {
      els.agentIdStatus.textContent = "Agent ID holder ✓";
      els.agentIdStatus.className = "badge ok";
      els.agentIdDetail.textContent = " — you can sign messages and like.";
    } else {
      els.agentIdStatus.textContent = "No Agent ID";
      els.agentIdStatus.className = "badge no";
      els.agentIdDetail.textContent = " — this wallet does not hold an Agent ID, so it cannot sign or like.";
    }
  } catch (err) {
    isHolder = false;
    els.agentIdStatus.textContent = "Check failed";
    els.agentIdStatus.className = "badge warn";
    els.agentIdDetail.textContent = " — could not read the Agent ID contract. " + friendlyError(err, "");
    showNotice("Could not check your Agent ID status: " + friendlyError(err, "network error."), "error");
  }
  updateComposeState();
  if (contractDeployed()) loadWall(); // refresh like-button states
}

/* ------------------------------------------------------------------ */
/* Wall                                                                */
/* ------------------------------------------------------------------ */
function contractDeployed() {
  return CONFIG.AGENT_WALL_ADDRESS && CONFIG.AGENT_WALL_ADDRESS.trim() !== "";
}

function getWallContract() {
  if (!contractDeployed() || !signer) return null;
  if (!wallContract) {
    wallContract = new ethers.Contract(CONFIG.AGENT_WALL_ADDRESS, AGENT_WALL_ABI, signer);
  }
  return wallContract;
}

async function loadWall() {
  if (!contractDeployed()) {
    els.wallMeta.textContent =
      "Preview mode — the contract is not deployed yet, so the wall below shows 3 local sample messages.";
    renderMessages(PREVIEW_MESSAGES, true);
    return;
  }

  els.wallMeta.textContent = "Newest first. Loading…";
  try {
    const readOnly = new ethers.Contract(CONFIG.AGENT_WALL_ADDRESS, AGENT_WALL_ABI, provider);
    let messages = null;

    // Prefer getTopMessages (returns message ids, newest first is done by
    // the sort below); fall back to getMessageCount + getMessage if that
    // call is not supported.
    try {
      const topIds = await readOnly.getTopMessages(CONFIG.WALL_PAGE_SIZE);
      messages = [];
      for (const id of topIds) {
        const m = await readOnly.getMessage(id);
        messages.push({
          id: Number(id),
          author: m.signer,
          text: m.message,
          likes: Number(m.likes),
          timestamp: Number(m.timestamp),
        });
      }
    } catch {
      const count = Number(await readOnly.getMessageCount());
      messages = [];
      const start = Math.max(0, count - CONFIG.WALL_PAGE_SIZE);
      for (let i = count - 1; i >= start; i--) {
        const m = await readOnly.getMessage(i);
        messages.push({
          id: i,
          author: m.signer,
          text: m.message,
          likes: Number(m.likes),
          timestamp: Number(m.timestamp),
        });
      }
    }

    messages.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
    els.wallMeta.textContent = "Newest first. " + messages.length + " message" + (messages.length === 1 ? "" : "s") + " on the wall.";
    renderMessages(messages, false);
  } catch (err) {
    els.wallMeta.textContent = "Newest first.";
    showNotice("Could not load the wall: " + friendlyError(err, "network error."), "error");
    renderMessages([], false);
  }
}

function renderMessages(messages, isPreview) {
  els.wall.innerHTML = "";
  els.wallEmpty.hidden = messages.length > 0;

  messages.forEach((m) => {
    const card = document.createElement("article");
    card.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = shortenAddress(m.author);
    const time = document.createElement("span");
    time.textContent = formatTime(m.timestamp);
    meta.appendChild(author);
    meta.appendChild(time);

    const text = document.createElement("p");
    text.className = "text";
    text.textContent = m.text; // textContent, never innerHTML — on-chain text is untrusted.

    const actions = document.createElement("div");
    actions.className = "actions";
    const likeBtn = document.createElement("button");
    likeBtn.type = "button";
    likeBtn.className = "small";
    likeBtn.textContent = likedIds.has(m.id) ? "♥ Liked" : "♡ Like";
    likeBtn.disabled = isPreview || !account || !isHolder || !onCorrectChain || likedIds.has(m.id);
    likeBtn.title = isPreview
      ? "Preview mode — likes need the deployed contract."
      : !account
        ? "Connect your wallet to like."
        : !isHolder
          ? "Only Agent ID holders can like."
          : likedIds.has(m.id)
            ? "You already liked this message."
            : "Like this message (on-chain, costs gas).";
    likeBtn.addEventListener("click", () => likeMessage(m.id, likeBtn));
    const likes = document.createElement("span");
    likes.className = "likes";
    likes.textContent = m.likes + (m.likes === 1 ? " like" : " likes");
    actions.appendChild(likeBtn);
    actions.appendChild(likes);

    card.appendChild(meta);
    card.appendChild(text);
    card.appendChild(actions);
    els.wall.appendChild(card);
  });
}

/* ------------------------------------------------------------------ */
/* Sign & like (both are on-chain transactions, approved in-wallet)     */
/* ------------------------------------------------------------------ */
async function signMessage() {
  const text = els.messageInput.value.trim();
  if (!text) {
    showNotice("Write a message first.", "warn");
    return;
  }
  if (text.length > CONFIG.MAX_MESSAGE_LENGTH) {
    showNotice("Your message is longer than " + CONFIG.MAX_MESSAGE_LENGTH + " characters.", "warn");
    return;
  }
  if (!account || !isHolder || !onCorrectChain) {
    showNotice("Connect a wallet holding an Agent ID on BNB Chain to sign.", "warn");
    return;
  }
  const contract = getWallContract();
  if (!contract) {
    showNotice("The contract is not deployed yet — signing is not available in preview mode.", "warn");
    return;
  }

  els.signBtn.disabled = true;
  try {
    showNotice("Your wallet will ask you to confirm the transaction. Signing publishes the message on-chain — it cannot be undone.", "info");
    const tx = await contract.sign(text);
    showNotice("Transaction sent (" + tx.hash + "). Waiting for confirmation…", "info");
    await tx.wait();
    els.messageInput.value = "";
    updateCharCount();
    showNotice("Published! Your message is now on the wall.", "info");
    await loadWall();
  } catch (err) {
    showNotice(friendlyError(err, "Signing failed."), "error");
  } finally {
    updateComposeState();
  }
}

async function likeMessage(messageId, button) {
  if (!account || !isHolder || !onCorrectChain) {
    showNotice("Connect a wallet holding an Agent ID on BNB Chain to like.", "warn");
    return;
  }
  const contract = getWallContract();
  if (!contract) return;
  button.disabled = true;
  try {
    showNotice("Your wallet will ask you to confirm the like transaction.", "info");
    const tx = await contract.like(messageId);
    showNotice("Like sent (" + tx.hash + "). Waiting for confirmation…", "info");
    await tx.wait();
    likedIds.add(messageId);
    showNotice("Liked!", "info");
    await loadWall();
  } catch (err) {
    showNotice(friendlyError(err, "Liking failed."), "error");
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Compose UI state                                                    */
/* ------------------------------------------------------------------ */
function updateCharCount() {
  const len = els.messageInput.value.length;
  els.charCount.textContent = len + " / " + CONFIG.MAX_MESSAGE_LENGTH;
  els.charCount.classList.toggle("over", len > CONFIG.MAX_MESSAGE_LENGTH);
}

function updateComposeState() {
  const canWrite = Boolean(account && isHolder && onCorrectChain && contractDeployed());
  els.messageInput.disabled = !canWrite;
  els.signBtn.disabled = !canWrite || els.messageInput.value.trim().length === 0;

  if (!contractDeployed()) {
    els.composeHint.textContent =
      "Preview mode — the contract is not deployed yet, so signing is disabled.";
  } else if (!account) {
    els.composeHint.textContent = "Connect your wallet and hold an Agent ID to sign a message.";
  } else if (!onCorrectChain) {
    els.composeHint.textContent = "Switch to BNB Chain to sign a message.";
  } else if (!isHolder) {
    els.composeHint.textContent = "This wallet does not hold an Agent ID, so it cannot sign messages.";
  } else {
    els.composeHint.textContent =
      "Signing publishes your message on-chain (public and permanent) and costs gas in BNB.";
  }
  // Like-button states refresh on the next wall load (after connect,
  // account/chain change, or a sign/like) — not while typing.
}

/* ------------------------------------------------------------------ */
/* Friendly errors                                                     */
/* ------------------------------------------------------------------ */
function friendlyError(err, fallback) {
  if (!err) return fallback || "Something went wrong.";
  const code = err.code;
  const message = String((err && err.reason) || err.message || "");

  if (code === "ACTION_REJECTED" || /user rejected/i.test(message) || /user denied/i.test(message)) {
    return "You rejected the request in your wallet. Nothing was sent.";
  }
  if (/already liked/i.test(message)) {
    return "You already liked this message — each wallet can like a message only once.";
  }
  if (/not (an? )?agent|no agent id|not a holder|not holder/i.test(message)) {
    return "This wallet does not hold an Agent ID, so it cannot do that.";
  }
  if (/insufficient funds/i.test(message)) {
    return "Not enough BNB in your wallet to pay the network (gas) fee.";
  }
  if (/network|timeout|fetch|failed to fetch/i.test(message)) {
    return "Network error while talking to the chain. Check your connection and try again.";
  }
  if (err.reason) return err.reason;
  if (fallback) return fallback + " " + message;
  return message || "Something went wrong.";
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */
function init() {
  if (typeof ethers === "undefined") {
    showNotice(
      "Could not load the wallet library (ethers) from the CDN. Check your internet connection and reload the page.",
      "error"
    );
    els.connectBtn.disabled = true;
    els.signBtn.disabled = true;
    els.messageInput.disabled = true;
  }

  if (contractDeployed()) {
    els.wallContractLabel.textContent = CONFIG.AGENT_WALL_ADDRESS;
  } else {
    els.wallContractLabel.textContent = "not deployed yet";
    // Don't overwrite the ethers-load error above when the CDN failed.
    if (typeof ethers !== "undefined") {
      showNotice(
        "The AgentInk contract is not deployed yet — preview mode: the wall below shows 3 local sample messages. Signing and liking are disabled until the contract address is set.",
        "warn"
      );
    }
  }

  els.connectBtn.addEventListener("click", connectWallet);
  els.switchChainBtn.addEventListener("click", switchToBsc);
  els.signBtn.addEventListener("click", signMessage);
  els.messageInput.addEventListener("input", () => {
    updateCharCount();
    updateComposeState();
  });

  updateCharCount();
  updateComposeState();
  loadWall();
}

document.addEventListener("DOMContentLoaded", init);
