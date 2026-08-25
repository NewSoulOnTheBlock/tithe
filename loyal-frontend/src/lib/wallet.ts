"use client";

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, type JsonRpcSigner } from "ethers";
import { CHAIN_ID, CHAIN_ID_HEX, CHAIN_PARAMS } from "./chain";

/**
 * Wallet connection, without a connector library.
 *
 * wagmi/RainbowKit would add megabytes and a provider tree to do what an
 * injected wallet already exposes: `eth_accounts`, `eth_requestAccounts`,
 * `wallet_switchEthereumChain`, and two events. This page needs exactly those
 * four things, so it asks for exactly those four things.
 *
 * ## Two rules it keeps
 *
 * **Never prompt on load.** The initial read uses `eth_accounts`, which returns
 * an already-authorised account and does nothing otherwise. `eth_requestAccounts`
 * — the one that opens the wallet — only ever fires from a click. A page that
 * pops a wallet dialog before you have asked for anything is a page people
 * close.
 *
 * **Chain state is not assumed.** Being connected and being on 4663 are
 * separate facts, and the UI has to be able to say "connected, wrong network"
 * because that is a real and common state that silently breaks every write.
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export type Wallet = {
  account: string | null;
  chainId: number | null;
  onCorrectChain: boolean;
  hasProvider: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  getSigner: () => Promise<JsonRpcSigner>;
};

export function useWallet(): Wallet {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasProvider, setHasProvider] = useState(false);

  useEffect(() => {
    const eth = window.ethereum;
    setHasProvider(!!eth);
    if (!eth) return;

    // `eth_accounts`, not `eth_requestAccounts` — this must never open a dialog.
    eth
      .request({ method: "eth_accounts" })
      .then((a) => {
        const list = a as string[];
        if (list?.length) setAccount(list[0]);
      })
      .catch(() => {});

    eth
      .request({ method: "eth_chainId" })
      .then((id) => setChainId(Number(id as string)))
      .catch(() => {});

    const onAccounts = (a: string[]) => setAccount(a?.length ? a[0] : null);
    const onChain = (id: string) => setChainId(Number(id));

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) {
      setError("No wallet found in this browser.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const a = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (a?.length) setAccount(a[0]);
      const id = (await eth.request({ method: "eth_chainId" })) as string;
      setChainId(Number(id));
    } catch (e: any) {
      // Code 4001 is the user closing the dialog. That is a decision, not a
      // fault, and surfacing it as an error would be scolding them for it.
      if (e?.code !== 4001) setError(e?.shortMessage ?? e?.message ?? "Could not connect.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (e: any) {
      // 4902: the wallet has never heard of this chain. Offering to add it is
      // the whole reason `CHAIN_PARAMS` exists.
      if (e?.code === 4902) {
        await eth
          .request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] })
          .catch(() => setError("Could not add Robinhood Chain."));
      } else if (e?.code !== 4001) {
        setError(e?.shortMessage ?? e?.message ?? "Could not switch network.");
      }
    }
  }, []);

  const getSigner = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) throw new Error("No wallet found.");
    return new BrowserProvider(eth as any).getSigner();
  }, []);

  return {
    account,
    chainId,
    onCorrectChain: chainId === CHAIN_ID,
    hasProvider,
    connecting,
    error,
    connect,
    switchChain,
    getSigner,
  };
}
