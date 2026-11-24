/**
 * hosts/submissions.ts — where a verified submission goes. This is the one
 * file to write for the project (with `calendar` below for bookings);
 * receiver.ts, bookings.ts and the host file stay as they are.
 *
 * TODO(nxis-action): store or forward each submission. Start with what the
 * project already uses, and ask the user which:
 *
 *   - Email: the project's mailer (Resend, Postmark, SES, nodemailer …) to the
 *     inbox that takes bookings or quote requests today
 *   - A webhook: the booking system, CRM or form service the site's own form
 *     posts to now. Send the idempotency key along (as an Idempotency-Key
 *     header, or a field), so a retry can't create a second record there
 *   - A database: one row per submission, with a unique index on the
 *     idempotency key, which also makes the dedupe durable on serverless hosts
 *
 * Until it is written, deliver() refuses with 501, so nothing is confirmed to
 * a visitor that went nowhere. Never log the submission's contents: it is
 * someone's name, phone and address.
 */
import { weeklyWindows, type CalendarOptions } from './bookings';
import type { Availability, Delivery, Submission } from './receiver';

/**
 * The booking calendar: when the business takes visits, how many at once, and
 * how long a check's hold keeps a seat while the visitor confirms. The host
 * file pairs it with a store (bookings.ts). TODO(nxis-action): set the hours,
 * the time zone and the capacity from the business's own (its opening hours,
 * its crews or chairs); ask the user. Where the business already keeps its
 * calendar in a booking system, read windows and seats from there instead and
 * keep the same answer shapes.
 */
export const calendar: CalendarOptions = {
  timeZone: 'America/Chicago',
  windowsOn: weeklyWindows({
    timeZone: 'America/Chicago',
    week: {
      mon: [['08:00', '12:00', 'morning'], ['12:00', '16:00', 'afternoon']],
      tue: [['08:00', '12:00', 'morning'], ['12:00', '16:00', 'afternoon']],
      wed: [['08:00', '12:00', 'morning'], ['12:00', '16:00', 'afternoon']],
      thu: [['08:00', '12:00', 'morning'], ['12:00', '16:00', 'afternoon']],
      fri: [['08:00', '12:00', 'morning'], ['12:00', '16:00', 'afternoon']],
    },
  }),
  capacity: 2,
  holdSeconds: 300,
  horizonDays: 30,
};

/**
 * Commit. Return the reference the business will know it by (it is read back
 * to the visitor as their confirmation), a conflict when a slot is taken
 * (409, with alternatives the agent offers instead), or a rejection naming the
 * fields that need attention. Throw only on a failure worth retrying.
 *
 * For a booking, bookings.ts has already taken the seat and passes the window
 * as `submission.booking` (`start`, `end`); anything but a reference gives the
 * seat back.
 */
export async function deliver(submission: Submission): Promise<Delivery> {
  // TODO(nxis-action): replace this with the project's destination, for example:
  //
  //   const reference = `WEB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  //   await fetch(process.env.SUBMISSIONS_WEBHOOK_URL!, {
  //     method: 'POST',
  //     headers: { 'content-type': 'application/json', 'idempotency-key': submission.idempotencyKey },
  //     body: JSON.stringify({ reference, action: submission.action, ...submission.args }),
  //   }).then((r) => { if (!r.ok) throw new Error(`destination answered ${r.status}`); });
  //   return { reference };
  void submission;
  throw new NotConfigured();
}

/**
 * Check (`"nxis:mode": "check"`): would this succeed? Answer from the rules
 * and change nothing: no email, no row. For a booking this runs first, and
 * when it answers available, bookings.ts adds the windows, the open seats and
 * a hold. For a quote it is the whole answer: `available`, and optionally
 * `service_area` (whether the business serves the address given) and
 * `fields` (what it still needs to quote). The price never comes from here;
 * an agent quotes from the site's published offers.
 */
export async function check(submission: Submission): Promise<Availability> {
  // TODO(nxis-action): refuse what the business can't take, for example an
  // address outside the service area:
  //
  //   const zip = String(submission.args.zip ?? '');
  //   if (zip && !SERVED_ZIPS.has(zip)) return { available: false, service_area: false, reason: 'Outside the service area.' };
  void submission;
  return { available: true };
}

/** Thrown by deliver() until it is written; the receiver answers 501 for it, and confirms nothing. */
export class NotConfigured extends Error {
  constructor() {
    super('This receiver is not taking submissions yet.');
    this.name = 'NotConfigured';
  }
}
