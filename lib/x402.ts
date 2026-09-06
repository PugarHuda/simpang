import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { bazaarResourceServerExtension } from '@x402/extensions/bazaar'
import { X402 } from './config'

/** The x402 resource server (seller side), one instance per process. The facilitator verifies the
 *  EIP-3009 signature and settles the USDC transfer; this code never touches a key.
 *  The Bazaar extension: a route that declares discovery gets indexed in the x402 catalog when a
 *  payment settles, so other agents can find SIMPANG's paid endpoint. */
export const x402Server = new x402ResourceServer(new HTTPFacilitatorClient({ url: X402.facilitator }))
  .register('eip155:*', new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension)
