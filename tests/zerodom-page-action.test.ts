import { describe, it, expect } from 'vitest';
import { parseHtml } from '@vexralabs/zerodom';
import { _diffCompact } from '../src/browser.js';

describe('zerodom page graph helpers', () => {
  it('parseHtml extracts nodes with selectors', () => {
    const g = parseHtml(
      '<html><body><a href="/">Home</a><input name="q"/><button>Search</button></body></html>',
      'https://example.com',
    );
    const payload = JSON.parse(g.toJson()) as { nodes: Record<string, unknown>[] };
    expect(payload.nodes.length).toBeGreaterThanOrEqual(3);
    const input = payload.nodes.find((n) => n.name === 'q' || n.label === 'q');
    expect(input?.selector).toBeTruthy();
  });

  it('parseHtml compact text is token-lean', () => {
    // A real-ish page: nav + form + footer — the compact graph should be
    // substantially shorter than the raw HTML (as proven on live sites:
    // ~71% fewer tokens on busybits).
    const html =
      '<html><body><nav><a href="/">Home</a><a href="/submit">Submit</a></nav>' +
      '<form><label for="url">Website URL:</label><input id="url" name="url"/>' +
      '<label for="title">Title:</label><input id="title" name="title"/>' +
      '<label for="cat">Category:</label><select id="cat" name="cat"><option>Business</option></select>' +
      '<button type="submit">Submit</button></form>' +
      '<footer><a href="/privacy">Privacy</a></footer></body></html>';
    const g = parseHtml(html, 'https://example.com');
    const compact = g.toCompactText();
    expect(compact.length).toBeLessThan(html.length);
    expect(compact).toMatch(/\[01\]/);
    expect(compact).toContain('Submit');
  });

  it('diffCompact returns empty for identical text', () => {
    const t = '[01] a "Home"\n[02] input "Search"';
    expect(_diffCompact(t, t)).toBe('');
  });

  it('diffCompact shows changes', () => {
    const before = '[01] a "Home"\n[02] input "Search"\n[03] a "About"';
    const after = '[01] a "Home"\n[02] input "Unlabelled Element"\n[03] a "About"';
    const diff = _diffCompact(before, after);
    expect(diff).toContain('Unlabelled');
    expect(diff).toContain('- ');
    expect(diff).toContain('+ ');
  });

  it('parse action handle formats via graph node ids', () => {
    // node_02 → [02] — zerodom pads to 2 digits in compact text.
    const g = parseHtml('<html><body><a href="/">Home</a><input name="q"/></body></html>');
    const payload = JSON.parse(g.toJson()) as { nodes: Record<string, unknown>[] };
    const q = payload.nodes.find((n) => n.label === 'q');
    expect(String(q?.id)).toMatch(/^node_\d+$/);
  });
});