// The operator's approval record for a live test.
//
// A real request can only be made to a hostname that appears, exactly, in a
// file like this one, which the operator fills in or approves. The file lives
// outside version control (research-private/), names real businesses, and
// expires: an approval older than MAX_APPROVAL_AGE_DAYS is refused.

import { z } from 'zod';
import { normalizeDomain } from '@/lib/identity';
import { validateApprovedHosts } from '@/lib/security/safe-fetch';

export const MAX_BUSINESSES = 5;
export const MAX_HOSTS_PER_BUSINESS = 2;
export const MAX_APPROVAL_AGE_DAYS = 14;

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/);

const BusinessSchema = z.strictObject({
  /** short handle used on the command line and in tracked documents, so real names stay out of them */
  label: z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/),
  displayName: line(120),
  city: line(80),
  state: z.string().regex(/^[A-Za-z]{2}$/),
  phone: z.string().trim().max(40).regex(/^[0-9()+.\- x]*$/).nullable().optional(),
  /** the website to investigate, for example "example.com" */
  domain: line(253),
  /** EXACT hostnames that may be requested for this business. Usually the domain and its "www." form. */
  approvedHosts: z.array(z.string()).min(1).max(MAX_HOSTS_PER_BUSINESS),
  /**
   * true only if the operator states that this website belongs to this business.
   * Used only when the site's own text does not confirm name and location.
   */
  operatorConfirmsIdentity: z.boolean(),
  /**
   * Optional. Approved hostnames (from approvedHosts) that may be read over plain HTTP
   * because the site itself redirects its HTTPS address there. Each needs the operator's say-so.
   */
  plainHttpHosts: z.array(z.string()).max(MAX_HOSTS_PER_BUSINESS).optional(),
  selectionNote: line(400),
});

export const ApprovalsSchema = z.strictObject({
  purpose: line(300),
  approvedBy: line(80),
  /** ISO timestamp of the approval */
  approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  /** how the approval was given, in the operator's or the recorder's words */
  approvalRecord: line(1500),
  businesses: z.array(BusinessSchema).min(1).max(MAX_BUSINESSES),
});

export type ApprovedBusiness = z.infer<typeof BusinessSchema> & { domain: string; approvedHosts: string[]; plainHttpHosts: string[] };
export type Approvals = Omit<z.infer<typeof ApprovalsSchema>, 'businesses'> & { businesses: ApprovedBusiness[] };

/** Parses and checks an approvals file. Throws an Error whose message says exactly what is wrong. */
export function parseApprovals(raw: unknown, now: Date): Approvals {
  const parsed = ApprovalsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The approvals file is not valid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown problem'}.`);
  }
  const approvedAt = new Date(parsed.data.approvedAt);
  if (Number.isNaN(approvedAt.getTime())) throw new Error('The approvals file has an unreadable approvedAt date.');
  if (approvedAt.getTime() > now.getTime() + 5 * 60_000) throw new Error('The approval is dated in the future.');
  if (now.getTime() - approvedAt.getTime() > MAX_APPROVAL_AGE_DAYS * 86_400_000) {
    throw new Error(`The approval is more than ${MAX_APPROVAL_AGE_DAYS} days old. Ask the operator to approve the hostnames again.`);
  }
  const labels = new Set<string>();
  const allHosts = new Set<string>();
  const businesses: ApprovedBusiness[] = parsed.data.businesses.map((b) => {
    if (labels.has(b.label)) throw new Error(`Label "${b.label}" is used twice.`);
    labels.add(b.label);
    const hosts = validateApprovedHosts(b.approvedHosts);
    const domain = normalizeDomain(b.domain);
    // The investigation starts at https://<domain>/, so that exact name must be approved.
    if (!hosts.includes(domain)) throw new Error(`Business ${b.label}: its domain "${domain}" is not in its own approvedHosts list.`);
    // Every approved name must be the domain itself or its "www." form: nothing unrelated can ride along.
    for (const host of hosts) {
      if (host !== domain && host !== `www.${domain}`) throw new Error(`Business ${b.label}: "${host}" is neither "${domain}" nor "www.${domain}".`);
      if (allHosts.has(host)) throw new Error(`Hostname "${host}" is listed for more than one business.`);
      allHosts.add(host);
    }
    const plainHttpHosts = (b.plainHttpHosts ?? []).map((h) => h.trim().toLowerCase());
    for (const host of plainHttpHosts) {
      if (!hosts.includes(host)) throw new Error(`Business ${b.label}: "${host}" is marked for plain HTTP but is not one of its approved hostnames.`);
    }
    return { ...b, domain, approvedHosts: hosts, plainHttpHosts };
  });
  return { ...parsed.data, businesses };
}
