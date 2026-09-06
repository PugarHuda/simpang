'use client'
import { createWalletClient, custom, type EIP1193Provider } from 'viem'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner } from '@x402/evm'
import { wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch'

/** Sisi pembeli x402 lewat SDK resmi. Wallet browser (MetaMask, Rabby, Coinbase Wallet)
 *  menandatangani EIP-3009 TransferWithAuthorization; @x402/fetch menangani 402 -> bayar
 *  -> ulang secara otomatis, dan facilitator men-settle transfer USDC-nya on-chain. */

type Win = Window & { ethereum?: EIP1193Provider }
export const hasWallet = () => typeof window !== 'undefined' && Boolean((window as Win).ethereum)

export async function paidFetch() {
  const eth = (window as Win).ethereum
  if (!eth) throw new Error('no EVM wallet in this browser')
  const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as `0x${string}`[]
  const wallet = createWalletClient({ account: address, transport: custom(eth) })
  const signer = toClientEvmSigner({
    address,
    signTypedData: (m) =>
      wallet.signTypedData({
        account: address,
        domain: m.domain,
        types: m.types as Record<string, readonly { name: string; type: string }[]>,
        primaryType: m.primaryType,
        message: m.message,
      }),
  })
  const client = new x402Client().register('eip155:*', new ExactEvmScheme(signer))
  return {
    address,
    fetch: wrapFetchWithPayment(fetch, client),
    settleOf: (res: Response) => {
      try { return new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n)) }
      catch { return null }
    },
  }
}
