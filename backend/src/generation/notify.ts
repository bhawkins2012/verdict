// "Ready for review" notice (docs/adr-generation-run.md Q13): one email to the admin who started the run,
// through the transactional mailer, once per run (the caller guarantees once). The in-app notice is the
// Admin badge (GET /api/admin/summary). A failed email is logged and never affects the run.
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { accountEmailSettings, sendAccountEmail } from '../auth/mailer'
import { message } from '../auth/emails'

export async function notifyRunReady(runId: string): Promise<void> {
  try {
    const run = await prisma.generationRun.findUnique({
      where: { id: runId },
      select: { id: true, node: { select: { id: true, name: true } }, createdBy: { select: { id: true, email: true } }, warning: true },
    })
    if (!run?.createdBy) return
    const settings = accountEmailSettings()
    const counts = await prisma.product.groupBy({ by: ['catalogStatus'], where: { discoveredByRunId: runId }, _count: { _all: true } })
    const count = (s: string) => counts.find((c) => c.catalogStatus === s)?._count._all ?? 0
    const link = `${settings.frontendUrl}/admin/nodes/${run.node.id}/review`
    await sendAccountEmail('generation-ready', message(settings, {
      to: run.createdBy.email,
      subject: `Ready for review: ${run.node.name}`,
      paragraphs: [
        `The generation run for ${run.node.name} has finished and is ready for review.`,
        `${count('APPROVED')} products were approved automatically and ${count('NEEDS_ATTENTION')} need attention.${run.warning ? ` ${run.warning}.` : ''}`,
      ],
      link: { href: link, label: 'Open the review screen' },
      idempotencyKey: `generation-ready/${run.id}`,
    }), undefined, run.createdBy.id)
  } catch (err) {
    logger.warn('Ready-for-review notice failed', { runId, errorClass: err instanceof Error ? err.name : typeof err })
  }
}
