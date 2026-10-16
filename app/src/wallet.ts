// Browser wallets: discovery (EIP-6963, with window.ethereum as a fallback), connecting, and following the
// wallet when its account or network changes. One instance per page, shared through the Store.
import { getAddress, type Address, type Chain } from "viem";

export interface Eip1193 {
  request(a: { method: string; params?: unknown[] }): Promise<any>;
  on?(ev: string, fn: (...a: any[]) => void): void;
  removeListener?(ev: string, fn: (...a: any[]) => void): void;
}
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string; // data URI
  rdns: string;
  provider: Eip1193;
}

const KEY = "wallet.rdns";
const found = new Map<string, WalletInfo>();
let onFound: (() => void) | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: any) => {
    const { info, provider } = e.detail ?? {};
    if (!info || ![info.rdns, info.uuid, info.name, info.icon].every(v => typeof v === "string")
      || !info.rdns || typeof provider?.request !== "function") return;
    found.set(info.rdns, { ...info, provider });
    onFound?.();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** wallets in this browser; an old-style injected one shows up as "Browser wallet" */
export function wallets(): WalletInfo[] {
  const list = [...found.values()];
  const eth = (window as any).ethereum as Eip1193 | undefined;
  if (!list.length && eth) list.push({ uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected", provider: eth });
  return list;
}

/** wait briefly for wallets to announce themselves (they answer within a few ms of the request) */
export function discover(ms = 300): Promise<WalletInfo[]> {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return new Promise((res) => {
    const t = setTimeout(() => res(wallets()), ms);
    onFound = () => {
      clearTimeout(t);
      setTimeout(() => res(wallets()), 30);
    };
  });
}

export type WalletState = { account: Address | ""; chainId: number; info: WalletInfo | null };

/** one connected wallet; `changed` fires on account switches, network switches and disconnects */
export class Connection {
  state: WalletState = { account: "", chainId: 0, info: null };
  private off: (() => void) | null = null;

  constructor(private chain: Chain, private changed: (s: WalletState) => void) {}

  get provider() {
    return this.state.info?.provider ?? null;
  }
  get wrongChain() {
    return !!this.state.account && this.state.chainId !== this.chain.id;
  }

  /** ask the wallet for access (shows its prompt), then remember it for next time */
  async connect(info: WalletInfo) {
    const [account] = await info.provider.request({ method: "eth_requestAccounts" });
    await this.adopt(info, account);
    try {
      localStorage.setItem(KEY, info.rdns);
    } catch {}
    if (this.wrongChain) await this.switchChain().catch(() => {});
  }

  /** reconnect without a prompt if this site was connected before and the wallet still allows it */
  async resume() {
    let rdns: string | null = null;
    try {
      rdns = localStorage.getItem(KEY);
    } catch {}
    if (!rdns) return false;
    const info = (await discover()).find((w) => w.rdns === rdns);
    if (!info) return false;
    const [account] = await info.provider.request({ method: "eth_accounts" }).catch(() => []);
    if (!account) return false;
    await this.adopt(info, account);
    return true;
  }

  disconnect() {
    try {
      localStorage.removeItem(KEY);
    } catch {}
    // newer wallets support revoking the site's access; others just forget us on our side
    this.provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
    this.off?.();
    this.off = null;
    this.state = { account: "", chainId: 0, info: null };
    this.changed(this.state);
  }

  async switchChain() {
    const p = this.provider;
    if (!p) return;
    const id = "0x" + this.chain.id.toString(16);
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
    } catch (e: any) {
      // 4902: the wallet doesn't know this network yet
      if (e?.code === 4001) throw e;
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: id, chainName: this.chain.name, nativeCurrency: this.chain.nativeCurrency, rpcUrls: this.chain.rpcUrls.default.http,
          ...(this.chain.blockExplorers && { blockExplorerUrls: [this.chain.blockExplorers.default.url] }) }],
      });
    }
    this.state.chainId = Number(await p.request({ method: "eth_chainId" }));
    this.changed(this.state);
  }

  private async adopt(info: WalletInfo, account: string) {
    this.off?.();
    const chainId = Number(await info.provider.request({ method: "eth_chainId" }));
    this.state = { account: getAddress(account), chainId, info }; // wallets may report any letter case
    const onAccounts = (accs: string[]) => {
      if (!accs?.length) return this.disconnect();
      this.state = { ...this.state, account: getAddress(accs[0]) };
      this.changed(this.state);
    };
    const onChain = (id: string) => {
      this.state = { ...this.state, chainId: Number(id) };
      this.changed(this.state);
    };
    info.provider.on?.("accountsChanged", onAccounts);
    info.provider.on?.("chainChanged", onChain);
    this.off = () => {
      info.provider.removeListener?.("accountsChanged", onAccounts);
      info.provider.removeListener?.("chainChanged", onChain);
    };
    this.changed(this.state);
  }
}
