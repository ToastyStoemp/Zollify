import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outgoing email - optional, and never in the way.
 *
 * Configured by SMTP_URL (e.g. `smtps://user:pass@smtp.example.com:465`) and
 * MAIL_FROM. A server without them simply sends nothing: callers get `false`
 * and say so to the person who triggered the mail, rather than failing the
 * action the email was only announcing.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Reply-To, e.g. the store owner a notice is from. */
  replyTo?: string;
  /** An iCalendar body (METHOD:PUBLISH), attached so mail clients offer "add to calendar". */
  ics?: string;
}

export interface Mailer {
  readonly enabled: boolean;
  /** True when the message was handed to the mail server. Never throws. */
  send(message: MailMessage): Promise<boolean>;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/** One plain address, nothing a parser could read as a list or a display name. */
export const isPlainEmail = (s: string): boolean => s.length <= 254 && EMAIL.test(s);

export function createMailer(
  opts: { url?: string; from?: string; transport?: Transporter } = {},
  log: (err: unknown) => void = () => {},
): Mailer {
  const from = opts.from || process.env.MAIL_FROM || '';
  const url = opts.url ?? process.env.SMTP_URL ?? '';
  const transport = opts.transport ?? (url && from ? nodemailer.createTransport(url) : null);
  if (!transport || !from) return { enabled: false, send: async () => false };

  return {
    enabled: true,
    async send(m) {
      if (!isPlainEmail(m.to) || (m.replyTo && !isPlainEmail(m.replyTo))) return false;
      try {
        await transport.sendMail({
          from,
          to: m.to,
          subject: m.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
          text: m.text,
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          ...(m.ics ? { icalEvent: { method: 'PUBLISH', filename: 'invite.ics', content: m.ics } } : {}),
        });
        return true;
      } catch (err) {
        log(err);
        return false;
      }
    },
  };
}
