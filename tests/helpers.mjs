/** Assertion helpers shared by the suites. */

import assert from 'node:assert/strict'

/** Deep equality with a readable label. */
export function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
}

/** Strict equality. */
export function is(actual, expected, message) {
  assert.strictEqual(actual, expected, message)
}

/** Truthiness. */
export function ok(value, message) {
  assert.ok(value, message)
}

/** Substring containment over a JSON rendering of the value. */
export function includes(value, needle, message) {
  assert.ok(
    JSON.stringify(value).includes(needle),
    `${message ?? 'expected to include'} ${needle}\n  in ${JSON.stringify(value)}`,
  )
}

/** Rejection with a specific `LlmError` code. */
export async function rejectsWithCode(promise, code, message) {
  try {
    await promise
  } catch (error) {
    assert.strictEqual(error?.code, code, `${message ?? 'wrong error code'}: got ${error?.code} (${error?.message})`)
    return error
  }
  throw new Error(`${message ?? 'expected a rejection with code'} ${code}, but nothing threw`)
}

/** Rejection whose message contains `needle`. */
export async function rejectsWith(promise, needle, message) {
  try {
    await promise
  } catch (error) {
    assert.ok(
      String(error?.message).includes(needle),
      `${message ?? 'expected message'}: got "${error?.message}"`,
    )
    return error
  }
  throw new Error(`${message ?? 'expected a rejection containing'} "${needle}", but nothing threw`)
}

export { assert }
