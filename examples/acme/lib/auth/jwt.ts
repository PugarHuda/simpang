import jwt from 'jsonwebtoken'
export const signJwt = (p: object) => jwt.sign(p, process.env.SECRET!, { expiresIn: '7d' })
export const verifyJwt = (t: string) => jwt.verify(t, process.env.SECRET!)
