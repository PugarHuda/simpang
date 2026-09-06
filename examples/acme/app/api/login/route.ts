import { loginUser } from '@/lib/auth'
export async function POST(req: Request) {
  const { email, pw } = await req.json()
  const token = await loginUser(email, pw)
  return Response.json({ token })
}
