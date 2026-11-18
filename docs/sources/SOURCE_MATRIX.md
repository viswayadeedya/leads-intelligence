# Source Matrix — Concrete Methods and Limits

| Signal | Primary source | Retrieval method | Key fields | Verification | MVP |
|---|---|---|---|---|---|
| Business identity | Google Places Text Search | Authorized API with field mask | place ID, name, address, website, phone where available | cross-check domain/location | yes, key optional |
| Competitor set | Google Places queries by service/location | Authorized API | businesses + websites | service-area match | later in MVP |
| Contact/booking UX | Business website | HTTP/HTML and Playwright for permitted pages | contact URLs, phone, forms, booking links, screenshots | inspect mobile and contact page | yes |
| Local discovery | Search API / manual sampled searches | Licensed provider or operator-provided URLs | exact query, location, result, timestamp | repeatability | optional |
| AI search presence | AI SERP provider, when authorized | Provider API | query, geo, citations/mentions | sampled, no universal claims | later |
| Reddit conversation | Public search discovery | Search engine URL discovery + manual logged-in review or authorized API | link, relevant observation, date | context and business identity | manual |
| Facebook conversation | Public search discovery | Search engine URL discovery + manual logged-in review or authorized integration | link, relevant observation, date | group privacy and identity | manual |
| Yelp reviews | Yelp Fusion API where licensed | Official API subject to tier and reuse terms | allowed review excerpts/metadata | quote context and recency | optional |
| BBB/other forums | Public discovery | Allowed API or permitted manual review | URL, observation | attribution and policy | optional |

## Documentation starting points (verify terms and pricing at implementation)
- Google Places Text Search: https://developers.google.com/maps/documentation/places/web-service/text-search
- Yelp API: https://docs.developer.yelp.com/
- Reddit developer policies: https://support.reddithelp.com/hc/en-us/articles/14945211791892-Reddit-Developer-Platform
- Meta platform docs: https://developers.facebook.com/docs/
- DataForSEO: https://docs.dataforseo.com/

## Hard rule
Publicly viewable does not mean unrestricted commercial reuse. `robots.txt` is not a permission grant. Internal logged-in accounts do not automatically authorize bulk automated collection. Never bypass CAPTCHA, access controls, or rate limits.
