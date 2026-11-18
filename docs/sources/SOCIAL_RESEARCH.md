# Social Conversation Intelligence

## Why it matters
Customer discussions reveal needs, recommendations, frustrations, and service-selection criteria. Owner discussions reveal operational pain, technology problems, and willingness to consider fixes. These are different signals and should not be conflated.

## Workflow in MVP
1. Discover candidate Reddit/Facebook URLs through permitted search results.
2. Human opens relevant links in their own authenticated browser when needed and permitted.
3. Human records a concise observation, source URL, context/date, whether business identity is confirmed, and sensitivity classification.
4. LLM analyzes the manually provided observation; verifier rejects overgeneralization.
5. Public reports include only evidence appropriate to share, respecting group privacy and platform rules.

## Group participation
Human may genuinely participate under community rules, disclose commercial interests when relevant, and avoid spam. No bot posting, auto-DMs, fake personas, or undisclosed solicitation.

## Distinguish evidence
- 'Someone asked for HVAC recommendations' = market demand, not a specific business failure.
- 'One commenter complained about a company' = unverified anecdote, not systemic proof.
- 'Owner says their missed calls are a problem' = owner-reported pain, still verify identity and context.

## Later integration
Define pluggable authorized connectors. Do not use personal login credentials as a substitute for authorization to automate scraping. Check current Meta/Reddit terms before adding any API or browser automation.
