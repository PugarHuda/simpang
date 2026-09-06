import { signJwt, verifyJwt } from './jwt'
export async function loginUser(email: string, pw: string) {
  const u = await db.user.findUnique({ where: { email } })
  if (!u || !(await compare(pw, u.hash))) return null
  return signJwt({ sub: u.id })
}
