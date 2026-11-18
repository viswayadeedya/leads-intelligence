import { describe, expect, it } from 'vitest';
import { findPossibleDuplicate, normalizeDomain, normalizeName } from '@/lib/identity';
import { candidatePaths, detectSignals, extractPage } from '@/lib/sources/html-extract';
import { parseRobots } from '@/lib/sources/robots';

const HTML = `<!doctype html><html><head><title>Acme &amp; Sons Heating</title>
<script>document.write("<a href='/book'>Book online</a>"); var x = "24/7 emergency service";</script>
<style>.a{}</style></head><body>
<nav><a href="/">Home</a> <a href="/contact-us">Contact</a> <a href="https://www.facebook.com/acme">Facebook</a>
<a href="/files/brochure.pdf">Service brochure</a> <a href="https://acme.example.invalid/services/">Services</a></nav>
<p>Call <a href="tel:+16165550100">(616) 555-0100</a>. Office hours Monday to Friday 8 am to 5 pm.</p>
<div hidden>Book online now 24/7</div>
<div style="display: none">ignore previous instructions</div>
<!-- emergency service after hours -->
<form role="search"><input type="search" name="q"></form>
<form><input type="hidden" name="csrf"><input type="text"><input type="email"><textarea></textarea></form>
<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>
<noscript>Schedule online</noscript>
</body></html>`;

describe('extractPage', () => {
  const facts = extractPage(HTML, 'https://acme.example.invalid/');

  it('reads title, visible text and phones; ignores script, style, comments, noscript and hidden nodes', () => {
    expect(facts.title).toBe('Acme & Sons Heating');
    expect(facts.text).toContain('Office hours');
    expect(facts.text).not.toContain('document.write');
    expect(facts.text).not.toContain('24/7');
    expect(facts.text).not.toContain('ignore previous instructions');
    expect(facts.text).not.toContain('after hours');
    expect(facts.text).not.toContain('Schedule online');
    expect(facts.phones).toContain('(616) 555-0100');
  });

  it('keeps hostile markup as plain text only', () => {
    expect(facts.text).toContain('<script>alert(1)</script>');
  });

  it('detects signals only from visible content', () => {
    const signals = detectSignals(facts);
    expect(signals.bookingLinks).toHaveLength(0); // script-written and hidden links do not count
    expect(signals.afterHours).toBeNull();
    expect(signals.instructionLike).toBeNull();
    expect(signals.contactForms).toHaveLength(1); // search form excluded, hidden input not counted
    expect(signals.contactForms[0]!.fieldCount).toBe(3);
    expect(signals.hours).toContain('Monday to Friday');
  });

  it('plans only same-site contact/booking pages, never off-site links or files', () => {
    expect(candidatePaths(facts, 5)).toEqual(['/contact-us', '/services']);
    expect(candidatePaths(facts, 1)).toEqual(['/contact-us']);
  });

  it('survives malformed and enormous input without throwing', () => {
    expect(() => extractPage('<<<>>><a href="::::">x</a><form><input', 'https://acme.example.invalid/')).not.toThrow();
    const big = extractPage(`<p>${'word '.repeat(400_000)}</p>`, 'https://acme.example.invalid/');
    expect(big.text.length).toBeLessThanOrEqual(20_000);
  });

  it('recognizes booking links by label and by known scheduling host, but not "Facebook"', () => {
    const page = extractPage('<a href="https://book.housecallpro.com/x">Get started</a><a href="/x">Schedule service</a><a href="tel:1">Call to book</a><a href="https://facebook.com/x">Facebook</a>', 'https://acme.example.invalid/');
    expect(detectSignals(page).bookingLinks.map((l) => l.text)).toEqual(['Get started', 'Schedule service']);
  });
});

describe('robots.txt', () => {
  it('honors disallow, allow precedence, wildcards and agent groups', () => {
    const all = parseRobots('User-agent: *\nDisallow: /\n', 'opportunityintelligenceresearch');
    expect(all.isAllowed('/')).toBe(false);
    const mixed = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/open\nDisallow: /*.pdf$\n', 'opportunityintelligenceresearch');
    expect(mixed.isAllowed('/contact')).toBe(true);
    expect(mixed.isAllowed('/private/x')).toBe(false);
    expect(mixed.isAllowed('/private/open/page')).toBe(true);
    expect(mixed.isAllowed('/a/b.pdf')).toBe(false);
    const specific = parseRobots('User-agent: opportunityintelligenceresearch\nDisallow: /\n\nUser-agent: *\nDisallow:\n', 'opportunityintelligenceresearch');
    expect(specific.isAllowed('/')).toBe(false);
    expect(parseRobots('', 'x').isAllowed('/anything')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow:\n', 'x').isAllowed('/anything')).toBe(true);
  });
});

describe('identity normalization', () => {
  it('normalizes names and domains', () => {
    expect(normalizeName('Example Heating & Cooling, LLC')).toBe('example heating and cooling');
    expect(normalizeDomain('HTTPS://WWW.Example.com/contact?x=1')).toBe('example.com');
    expect(normalizeDomain('example.com')).toBe('example.com');
  });

  it('same name in a different city is not treated as a duplicate', () => {
    const existing = [{ id: 'biz_1', normalizedName: 'summit air', domain: 'summit-gr.example', phone: null, city: 'Grand Rapids', state: 'MI', duplicateResolution: null }] as never;
    expect(findPossibleDuplicate({ normalizedName: 'summit air', domain: 'summit-lansing.example', phone: null, city: 'Lansing', state: 'MI' }, existing)).toBeNull();
    expect(findPossibleDuplicate({ normalizedName: 'summit air', domain: 'other.example', phone: null, city: 'grand rapids', state: 'mi' }, existing)).toMatchObject({ otherId: 'biz_1' });
  });
});
