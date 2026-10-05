import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { createMailer, isPlainEmail } from '../mailer';

describe('mailer', () => {
  it('is off without a transport and a sender', async () => {
    const m = createMailer({ url: '', from: '' });
    expect(m.enabled).toBe(false);
    expect(await m.send({ to: 'a@example.test', subject: 's', text: 't' })).toBe(false);
  });

  it('sends plain text with a calendar file attached', async () => {
    const out: string[] = [];
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const send = transport.sendMail.bind(transport);
    transport.sendMail = (async (msg: Parameters<typeof send>[0]) => {
      const info = await send(msg);
      out.push(String((info as unknown as { message: Buffer }).message));
      return info;
    }) as typeof transport.sendMail;
    const m = createMailer({ from: 'Zollify <no-reply@example.test>', transport });
    expect(await m.send({ to: 'ana@example.test', subject: 'Setup\r\nBcc: x@evil.test', text: 'Hi', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' })).toBe(true);
    expect(out[0]).toContain('Subject: Setup Bcc: x@evil.test');
    expect(out[0]).not.toMatch(/^Bcc:/m);
    expect(out[0]).toContain('text/calendar');
  });

  it('refuses anything but one plain address', async () => {
    expect(isPlainEmail('ana@example.test')).toBe(true);
    for (const bad of ['a@b', 'a@example.test, b@example.test', 'Ana <a@example.test>', 'a@example.test\r\nBcc: x@y.z']) expect(isPlainEmail(bad)).toBe(false);
  });
});
