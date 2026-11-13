import { parseTrustProxy } from '../src/lib/trustProxy'

describe('parseTrustProxy', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['  ', 1],
    ['1', 1],
    ['2', 2],
    ['0', 0],
    ['false', false],
    ['FALSE', false],
    ['loopback', 'loopback'],
    ['loopback, 10.0.0.0/8', 'loopback, 10.0.0.0/8'],
    ['203.0.113.5', '203.0.113.5'],
  ])('%j -> %j', (input, expected) => {
    expect(parseTrustProxy(input)).toBe(expected)
  })

  it.each(['true', 'TRUE', ' true ', '0.0.0.0/0', '::/0', '10.0.0.0/8, ::/0', 'loopback,true'])(
    'refuses the permissive value %j',
    (input) => {
      expect(() => parseTrustProxy(input)).toThrow(/spoof/)
    }
  )
})
