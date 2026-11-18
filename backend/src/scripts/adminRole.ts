// npm run admin:grant -- <email>   /   npm run admin:revoke -- <email>
//
// The only way to make someone an admin outside development and test (docs/adr-levers.md D1): no API
// grants roles. Looks the user up by the normalized address. Takes effect on the user's next request
// (the role is read from the database every time).
import 'dotenv/config'
import { PrismaClient, UserRole } from '@prisma/client'
import { normalizeEmail } from '../auth/emailAddress'

export async function setAdminRole(prisma: PrismaClient, action: string | undefined, rawEmail: string | undefined): Promise<{ ok: boolean; message: string }> {
  if ((action !== 'grant' && action !== 'revoke') || !rawEmail) {
    return { ok: false, message: 'Usage: npm run admin:grant -- <email>  |  npm run admin:revoke -- <email>' }
  }
  const email = normalizeEmail(rawEmail)
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } })
  if (!user) return { ok: false, message: `No user with address ${email}` }
  const role = action === 'grant' ? UserRole.ADMIN : UserRole.USER
  await prisma.user.update({ where: { id: user.id }, data: { role } })
  return { ok: true, message: `${email} is now ${role === UserRole.ADMIN ? 'an admin' : 'a regular user'} (was ${user.role})` }
}

if (require.main === module) {
  const prisma = new PrismaClient()
  setAdminRole(prisma, process.argv[2], process.argv[3])
    .then((r) => { (r.ok ? console.log : console.error)(r.message); if (!r.ok) process.exitCode = 1 })
    .catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
