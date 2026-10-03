import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelOptions,
  derivePairing,
  isCompositeRef,
  pairingFromMessages,
  refOf,
  shortRef,
} from '../src/tui-helpers.ts'

test('refOf composes provider/model#variant', () => {
  assert.equal(refOf('devin', 'swe-2-max'), 'devin/swe-2-max')
  assert.equal(refOf('opencode', 'big-pickle', 'max'), 'opencode/big-pickle#max')
  assert.equal(refOf('opencode', 'big-pickle', 'default'), 'opencode/big-pickle')
})

test('shortRef strips the provider segment', () => {
  assert.equal(shortRef('devin/swe-2-max'), 'swe-2-max')
  assert.equal(shortRef('opencode/fledge-alpha-free#max'), 'fledge-alpha-free#max')
  assert.equal(shortRef(undefined), '?')
})

test('isCompositeRef detects generated fusion providers', () => {
  assert.equal(isCompositeRef('opencode-fusion-devin/preset-2'), true)
  assert.equal(isCompositeRef('devin/swe-2-max'), false)
  assert.equal(isCompositeRef(undefined), false)
})

test('buildModelOptions flattens models x variants, groups by provider', () => {
  const options = buildModelOptions([
    {
      providerID: 'devin',
      id: 'swe-2-max',
      name: 'SWE-2 Max',
      enabled: true,
      variants: [{ id: 'max' }],
    },
    { providerID: 'opencode', id: 'big-pickle', name: 'Big Pickle', enabled: true },
    { providerID: 'opencode', id: 'disabled-m', enabled: false },
    { providerID: 'opencode-fusion-devin', id: 'preset-0', enabled: true },
  ])
  const values = options.map((o) => o.value)
  assert.deepEqual(values, ['devin/swe-2-max', 'devin/swe-2-max#max', 'opencode/big-pickle'])
  assert.ok(options.every((o) => o.category))
})

test('pairingFromMessages reads the newest fusion status synthetic', () => {
  const messages = [
    { type: 'user', text: 'hi' },
    { type: 'synthetic', text: '{"enabled":true,"lead":"a/l#max","partner":"b/p","composite":"c/0"}' },
    { type: 'assistant', text: 'later text' },
    { type: 'synthetic', text: '{"enabled":true,"lead":"x/l","partner":"y/p2#high"}' },
  ]
  assert.deepEqual(pairingFromMessages(messages), { lead: 'x/l', partner: 'y/p2#high' })
  assert.equal(pairingFromMessages([{ type: 'user', text: 'nothing' }]), undefined)
  assert.equal(
    pairingFromMessages([{ type: 'synthetic', text: '{not json' }]),
    undefined,
  )
})

test('derivePairing prefers remembered, then status, then inference', () => {
  const remembered = { lead: 'r/l', partner: 'r/p' }
  assert.equal(
    derivePairing({ remembered, messages: [] }).lead,
    'r/l',
  )
  const viaStatus = derivePairing({
    messages: [
      { type: 'synthetic', text: '{"lead":"s/l","partner":"s/p","composite":"c/p0"}' },
    ],
  })
  assert.equal(viaStatus.lead, 's/l')
  assert.equal(viaStatus.composite, 'c/p0')
  const inferred = derivePairing({
    messages: [],
    sessionModel: { providerID: 'devin', id: 'swe-2-max' },
    childModel: { providerID: 'opencode', id: 'big-pickle' },
  })
  assert.deepEqual(inferred, {
    lead: 'devin/swe-2-max',
    partner: 'opencode/big-pickle',
    composite: undefined,
  })
  const composite = derivePairing({
    messages: [],
    sessionModel: { providerID: 'opencode-fusion-devin', id: 'preset-2' },
  })
  assert.equal(composite.lead, 'opencode-fusion-devin/preset-2')
  assert.equal(composite.composite, 'opencode-fusion-devin/preset-2')
  assert.equal(derivePairing({ messages: [] }), undefined)
})
