import { describe, expect, it } from 'vitest';
import { serializedMsgId } from '../src/transport/wwebjs/compat.js';

describe('serializedMsgId', () => {
  it('uses _serialized when WhatsApp still provides it', () => {
    expect(serializedMsgId({ _serialized: 'false_1@c.us_ABC' })).toBe('false_1@c.us_ABC');
  });

  it('rebuilds the id from its parts when _serialized is missing (renamed to $1)', () => {
    expect(
      serializedMsgId({
        fromMe: true,
        remote: '15195@lid',
        id: '3EB0C5',
        $1: 'true_15195@lid_3EB0C5',
      }),
    ).toBe('true_15195@lid_3EB0C5');
  });

  it('includes the group participant', () => {
    expect(
      serializedMsgId({
        fromMe: false,
        remote: { _serialized: '1203@g.us' },
        id: 'XYZ',
        participant: { _serialized: '91999@c.us' },
      }),
    ).toBe('false_1203@g.us_XYZ_91999@c.us');
  });

  it('falls back to any cached serialised string, then empty', () => {
    expect(serializedMsgId({ weird: 'true_1@c.us_Q' })).toBe('true_1@c.us_Q');
    expect(serializedMsgId(undefined)).toBe('');
    expect(serializedMsgId('false_2@c.us_R')).toBe('false_2@c.us_R');
  });
});
