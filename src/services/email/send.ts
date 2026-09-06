import { Resend } from "resend";
import { env } from "../../config/env.js";
import logger from "../../utils/logger.utils.js";

/**
 * Mail, for the handful of things that happen while nobody is looking.
 *
 * The bell in the header covers everything a person sees when they are already
 * here. Email is for the rest: an invite to someone who has no account yet and
 * therefore no inbox to write a row into, and the events an agent causes at
 * four in the morning.
 *
 * **Never let a send break the thing that caused it.** A sale is a sale whether
 * or not the receipt arrives, and an invite row is what actually grants the
 * share. So every function here swallows its own failures and logs them. If a
 * caller ever needs to know, it has to ask for that explicitly.
 *
 * Without `RESEND_API_KEY` nothing is sent and the intended message is logged.
 * That keeps a local run working and makes the absence visible rather than
 * silent.
 *
 * **Current limitation, and it is Resend's, not ours.** With no verified domain
 * the sender is `onboarding@resend.dev`, and Resend will only deliver that to
 * the address the account was registered with. Everything below is correct and
 * tested; mail to anyone else is refused until a domain is verified, and that
 * refusal is logged with the recipient so it reads as configuration rather than
 * a bug.
 */

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export type Mail = {
  to: string;
  subject: string;
  /** Plain text. Deliberately not HTML: these are four short factual notes. */
  text: string;
};

export async function sendMail(mail: Mail): Promise<boolean> {
  if (!resend) {
    logger.info({ to: mail.to, subject: mail.subject }, "email not sent: no RESEND_API_KEY");
    return false;
  }

  try {
    const { error } = await resend.emails.send({
      from: env.RESEND_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
    if (error) {
      logger.warn({ to: mail.to, subject: mail.subject, error: error.message }, "email rejected");
      return false;
    }
    logger.info({ to: mail.to, subject: mail.subject }, "email sent");
    return true;
  } catch (err) {
    logger.error({ err, to: mail.to }, "email send threw");
    return false;
  }
}

export function appUrl(path: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}${path}`;
}
