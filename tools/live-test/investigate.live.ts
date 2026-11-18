// Entry point for the operator live test. Started ONLY by
// scripts/live-investigate.mjs, which sets the variables below after its own
// checks. It runs under the project's test runner because that is the
// project's only TypeScript runner; it is not a test, and `npm test` never
// includes it.
//
// It refuses to do anything unless all three variables are present and agree.

import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import { parseApprovals } from './approvals';
import { runLiveInvestigation } from './run';

export const CONFIRM_PHRASE = 'operator-approved-hosts-only';

it('operator live test', async () => {
  const { OI_LIVE_CONFIRM, OI_LIVE_APPROVALS, OI_LIVE_BUSINESS, OI_LIVE_OUT } = process.env;
  if (OI_LIVE_CONFIRM !== CONFIRM_PHRASE || !OI_LIVE_APPROVALS || !OI_LIVE_BUSINESS || !OI_LIVE_OUT) {
    throw new Error('Refused: the live test was not started through scripts/live-investigate.mjs with an approvals file, a business label and the confirmation flag. No request was made.');
  }
  const file = path.resolve(OI_LIVE_APPROVALS);
  const approvals = parseApprovals(JSON.parse(fs.readFileSync(file, 'utf8')), new Date());
  const result = await runLiveInvestigation({ approvals, label: OI_LIVE_BUSINESS, outDir: path.resolve(OI_LIVE_OUT), log: (line) => console.log(line) });
  console.log(`RESULT ${JSON.stringify({ label: result.summary.label, status: result.status, report: path.relative(process.cwd(), result.reportPath), seconds: Math.round(result.summary.wallClockMs / 100) / 10, pageRequests: result.summary.requestLog.length, wireRequests: result.summary.wireRequests, identity: result.summary.identityConfirmedBy })}`);
});
