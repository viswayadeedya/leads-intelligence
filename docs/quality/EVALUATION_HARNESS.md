# Evaluation harness — how to know the system works
A feature is not done because the UI renders or the LLM says it is correct.

## Golden set
Create at least 12 fictional/consented test cases: correct company; same-name different city; parent/subsidiary ambiguity; outdated webpage; no booking link but phone scheduling; source 403; robots disallow; malicious prompt injection in HTML; contradictory customer comments; false revenue claim; private-group note accidentally included in owner preview; duplicate company with two domains. Label expected outcomes and evidence IDs. Never treat mock fixtures as actual prospect evidence.

## Metrics
Identity precision, claim support rate, unsupported-claim count, restricted-evidence leakage count, false positive opportunity rate, source retrieval success by adapter, median cost/run, median time/run, manual review minutes, draft usefulness (human rubric). Report denominators and uncertainty; no fake accuracy.

## Release gates
- Zero unsupported factual claims in golden tests.
- Zero restricted-source material in owner-preview/export tests.
- Cross-user authorization negative tests pass where relevant.
- SSRF, prompt injection, secret leakage, and untrusted HTML tests pass.
- A complete mock run and a permitted live run (when credentials are provided) produce traceable evidence.
- Manual 5-task usability test completed and issues triaged.
- Source adapter failures don't convert to 'no problems found'.

## Review protocol
For each opportunity, human reviewer checks identity, source, time, observed vs inferred, counterexample, commercial relevance, and whether owner would find it fair. Store decision and reason. Re-run after any model/prompt/source-adapter change.
