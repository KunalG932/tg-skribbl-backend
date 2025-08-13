import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../src/security/rateLimit.js'

test('rate limiter allows up to count within window', async () => {
  const rl = createRateLimiter({ count: 3, windowMs: 100 })
  assert.equal(rl.allow(), true)
  assert.equal(rl.allow(), true)
  assert.equal(rl.allow(), true)
  assert.equal(rl.allow(), false)
  // after window passes, should allow again
  await new Promise(r => setTimeout(r, 110))
  assert.equal(rl.allow(), true)
})
