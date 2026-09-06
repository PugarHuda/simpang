import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { bazaarResourceServerExtension } from '@x402/extensions/bazaar'
import { X402 } from './config'

/** Resource server x402 (sisi penjual), satu instance per proses. Facilitator memverifikasi
 *  tanda tangan EIP-3009 dan menyelesaikan transfer USDC; kode ini tidak menyentuh kunci apa pun.
 *  Ekstensi Bazaar: route yang mendeklarasikan discovery ikut terindeks di katalog x402
 *  saat di-settle, jadi agent lain bisa menemukan endpoint berbayar SIMPANG. */
export const x402Server = new x402ResourceServer(new HTTPFacilitatorClient({ url: X402.facilitator }))
  .register('eip155:*', new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension)
