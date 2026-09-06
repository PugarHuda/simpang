import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { X402 } from './config'

/** Resource server x402 (sisi penjual), satu instance per proses. Facilitator memverifikasi
 *  tanda tangan EIP-3009 dan menyelesaikan transfer USDC; kode ini tidak menyentuh kunci apa pun. */
export const x402Server = new x402ResourceServer(new HTTPFacilitatorClient({ url: X402.facilitator }))
  .register('eip155:*', new ExactEvmScheme())
