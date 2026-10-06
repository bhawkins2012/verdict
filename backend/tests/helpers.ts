import request from 'supertest'
import { randomUUID } from 'crypto'
import { app } from '../src/app'
import { prisma } from '../src/lib/prisma'

export const api = () => request(app)

export function uniqueUser() {
  const id = randomUUID().slice(0, 8)
  return { email: `t_${id}@example.com`, username: `t_${id}`, password: 'password123' }
}

export async function registerUser() {
  const user = uniqueUser()
  const res = await api().post('/api/auth/register').send(user)
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { ...user, id: res.body.user.id as string, accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string }
}

export async function createProduct() {
  return prisma.product.create({ data: { name: `Test Product ${randomUUID().slice(0, 6)}`, category: 'test' } })
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

// Users cascade to threads, reviews, nudges and refresh tokens.
export async function cleanup(userIds: string[], productIds: string[] = []) {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.product.deleteMany({ where: { id: { in: productIds } } })
}
