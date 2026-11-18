# Independent Reviewer Checklist

The reviewer is a skeptical product, engineering, and evidence validator. Review outputs against files, not sales language.

## Review order
1. Does a real working vertical slice exist? Run it.
2. Does every factual claim have valid evidence and a correct business match?
3. Are blocked/missing sources distinguished from negative findings?
4. Is the report useful to an HVAC owner, not merely impressive to a developer?
5. Is the workflow cheap, fast, and repeatable?
6. Are all external actions gated by human approval?
7. Are privacy, security, and platform access boundaries enforced?
8. Does the code match documentation and tests?

## Reviewer output format
Verdict: PASS / CONDITIONAL / FAIL. List critical issues first, with exact file/line and reproduction steps. Then useful improvements ranked by customer value. No vague praise or generic refactor advice. A pretty dashboard without a validated report is FAIL.

## Mandatory security gate
Review against `../security/SECURITY_PROTOCOL.md` and log evidence in `../security/SECURITY_REVIEW_CHECKLIST.md`. Do not approve deployment if applicable security tests have not passed.
