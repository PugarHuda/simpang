import { verifyJwt } from '@/lib/auth/jwt'
export async function GET(req: Request) {
  const t = req.headers.get('authorization')?.slice(7)
  return Response.json(verifyJwt(t!))
}
