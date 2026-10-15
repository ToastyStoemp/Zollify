import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { FeedbackSchema, type AdminFeedbackEntry } from '@zollify/shared';
import type { JwtClaims } from '../auth';

/**
 * Feedback from the app: a bug report or an idea, sent by anyone signed in.
 * Kept here for the server owner (Settings → Server admin), and posted to a
 * Discord channel when FEEDBACK_DISCORD_WEBHOOK is set - with the message,
 * the screen and the app version only: no name, email or account goes to
 * Discord (a US service), the owner looks those up here by the short id.
 *
 * Also the server's Discord invite (DISCORD_INVITE_URL), for the app to
 * link to - public, so the sign-in screen can show it too.
 */

const DISCORD_WEBHOOK = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
const DISCORD_INVITE = /^https:\/\/(?:discord\.gg\/[\w-]+|(?:www\.)?discord\.com\/invite\/[\w-]+)\/?$/;

export const discordInvite = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const url = env.DISCORD_INVITE_URL?.trim() ?? '';
  return DISCORD_INVITE.test(url) ? url : null;
};

/** The Discord message for one piece of feedback; mentions are switched off so nobody can ping @everyone through it. */
export function discordMessage(f: { id: string; kind: 'bug' | 'idea'; message: string; page?: string; appVersion?: string }, at = new Date()) {
  const fields = [
    ...(f.page ? [{ name: 'Screen', value: f.page.slice(0, 200), inline: true }] : []),
    ...(f.appVersion ? [{ name: 'Version', value: f.appVersion.slice(0, 60), inline: true }] : []),
  ];
  return {
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: f.kind === 'bug' ? 'Bug report' : 'Idea',
        description: f.message.slice(0, 3900),
        color: f.kind === 'bug' ? 0xc6512f : 0x2fbf8f,
        fields,
        footer: { text: `feedback ${f.id.slice(0, 8)}` },
        timestamp: at.toISOString(),
      },
    ],
  };
}

export function registerFeedbackRoutes(app: FastifyInstance, db: Database.Database): void {
  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if ((req.user as JwtClaims).role !== 'owner') reply.code(403).send({ error: 'Owner only' });
  };

  app.get('/api/support', async () => ({ discordUrl: discordInvite() }));

  app.post('/api/feedback', { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = FeedbackSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Check your message.' });
    const claims = req.user as JwtClaims;
    const id = randomUUID();
    const f = parsed.data;
    db.prepare('INSERT INTO feedback (id, accountId, userId, kind, message, page, appVersion, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      claims.accountId,
      claims.sub,
      f.kind,
      f.message,
      f.page ?? null,
      f.appVersion ?? null,
      Date.now(),
    );
    const hook = process.env.FEEDBACK_DISCORD_WEBHOOK?.trim() ?? '';
    if (DISCORD_WEBHOOK.test(hook)) {
      // Not awaited: the feedback is saved whether or not Discord answers.
      void fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(discordMessage({ id, ...f })), redirect: 'error', signal: AbortSignal.timeout(10_000) })
        .then((res) => {
          if (!res.ok) app.log.warn({ status: res.status }, 'feedback not posted to Discord');
        })
        .catch((err) => app.log.warn({ err }, 'feedback not posted to Discord'));
    }
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/admin/feedback', { preHandler: [app.authenticate, requireOwner] }, async (): Promise<AdminFeedbackEntry[]> =>
    db
      .prepare(
        `SELECT f.id, f.accountId, a.name AS accountName, u.email, f.kind, f.message, f.page, f.appVersion, f.createdAt
         FROM feedback f JOIN accounts a ON a.id = f.accountId LEFT JOIN users u ON u.id = f.userId
         ORDER BY f.createdAt DESC LIMIT 200`,
      )
      .all() as AdminFeedbackEntry[],
  );
}
