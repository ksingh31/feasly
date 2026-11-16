/** lib/embed-origin (#870) — pure origin parsing. */
import { describe, expect, it } from 'vitest';
import { parseEmbedOrigin } from '../src/lib/embed-origin';

describe('parseEmbedOrigin', () => {
  it.each([
    ['https://www.builder.example', 'https://www.builder.example'],
    ['https://WWW.Builder.example/', 'https://www.builder.example'],
    ['  https://builder.example:8443 ', 'https://builder.example:8443'],
    ['https://builder.example:443', 'https://builder.example'],
    ['http://localhost:4200', 'http://localhost:4200'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
  ])('accepts %s', (input, expected) => {
    expect(parseEmbedOrigin(input)).toBe(expected);
  });

  it.each([
    'http://builder.example',
    'https://builder.example/page',
    'https://builder.example//',
    'https://builder.example?',
    'https://builder.example/?q=1',
    'https://builder.example#top',
    'https://user:pw@builder.example',
    'ftp://builder.example',
    'javascript:alert(1)',
    'builder.example',
    '',
    '*',
    `https://${'a'.repeat(260)}.example`,
    42,
    null,
  ])('rejects %s', (input) => {
    expect(parseEmbedOrigin(input)).toBeNull();
  });
});
