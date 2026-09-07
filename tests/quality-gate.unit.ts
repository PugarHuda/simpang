import { test, expect } from '@playwright/test'
import { qualityGate, type DivergenceSet } from '@/lib/divergence'

// The quality gate is the one part of the scan that does not depend on a model behaving, so it is
// the one part that can be tested for free. Everything the README calls deterministic is asserted
// here — no browser, no server, no spend.

type Raw = DivergenceSet['divergences'][number]

/** A divergence that passes every rule, so each test can break exactly one thing. */
const ok = (over: Partial<Raw> = {}): Raw => ({
  id: 'session_storage',
  axis: 'session storage',
  question: 'Where do sessions live?',
  branches: [
    { label: 'redis', sketch: 'new dependency', filesTouched: 3, costUsd: 1, confidence: 0.6, constraintIfPinned: 'Use redis for sessions.' },
    { label: 'postgres table', sketch: 'no new service', filesTouched: 2, costUsd: 1, confidence: 0.4, constraintIfPinned: 'Use a postgres sessions table.' },
  ],
  ...over,
})
const gate = (...divergences: Raw[]) => qualityGate({ etaSeconds: 120, divergences })

test('keeps a well-formed divergence', () => {
  expect(gate(ok())).toHaveLength(1)
})

test('drops a leader too confident to be a decision', () => {
  const branches = ok().branches.map((b, i) => ({ ...b, confidence: i === 0 ? 0.9 : 0.1 }))
  expect(gate(ok({ branches }))).toHaveLength(0)
})

test('drops confidences that do not sum to 1', () => {
  const branches = ok().branches.map((b) => ({ ...b, confidence: 0.4 }))
  expect(gate(ok({ branches }))).toHaveLength(0)
})

test('drops two branches wearing the same label', () => {
  const branches = ok().branches.map((b) => ({ ...b, label: 'Redis ' }))
  expect(gate(ok({ branches }))).toHaveLength(0)
})

test('drops anything that is not exactly two branches', () => {
  expect(gate(ok({ branches: [ok().branches[0]] }))).toHaveLength(0)
  expect(gate(ok({ branches: [...ok().branches, ok().branches[0]] }))).toHaveLength(0)
})

test('keeps only the first of two divergences sharing an id', () => {
  // Ids become the enum of the `decide` tool, so a duplicate would make one of them unreachable.
  const kept = gate(ok(), ok({ axis: 'something else' }))
  expect(kept).toHaveLength(1)
  expect(kept[0].axis).toBe('session storage')
})

test('normalises ids into snake_case slugs', () => {
  expect(gate(ok({ id: '  Session Storage! ' }))[0].id).toBe('session_storage')
})

test('never returns more than the configured maximum', () => {
  const many = Array.from({ length: 9 }, (_, i) => ok({ id: `d${i}` }))
  expect(gate(...many).length).toBeLessThanOrEqual(5)
})

test('derives the kill constraint instead of trusting the model for it', () => {
  // The rule the whole "kill is instant" claim rests on: killing a branch must forbid THAT branch
  // and force its opposite. Scan models were observed swapping the two.
  const [d] = gate(ok())
  expect(d.branches[0].constraintIfKilled).toBe('Do NOT choose "redis". Use a postgres sessions table.')
  expect(d.branches[1].constraintIfKilled).toBe('Do NOT choose "postgres table". Use redis for sessions.')
})

test('strips comment markers some models prefix onto constraints', () => {
  const branches = ok().branches.map((b) => ({ ...b, constraintIfPinned: `// - ${b.constraintIfPinned}` }))
  const [d] = gate(ok({ branches }))
  expect(d.branches[0].constraintIfPinned).toBe('Use redis for sessions.')
  expect(d.branches[1].constraintIfKilled).not.toContain('//')
})

test('rounds the file count, and lets impossible confidences fail the gate', () => {
  // Clamping guards what survives; it is not a way to rescue nonsense. Out-of-range confidences
  // stop summing to 1, so the divergence is dropped rather than quietly repaired.
  const broken = [
    { ...ok().branches[0], confidence: 1.4 },
    { ...ok().branches[1], confidence: -0.4 },
  ]
  expect(gate(ok({ branches: broken }))).toHaveLength(0)

  const fine = [
    { ...ok().branches[0], confidence: 0.55, filesTouched: 3.7 },
    { ...ok().branches[1], confidence: 0.45, filesTouched: 2.2 },
  ]
  const [d] = gate(ok({ branches: fine }))
  expect(d.branches[0].filesTouched).toBe(4)
  expect(d.branches[1].filesTouched).toBe(2)
})

test('truncates long axes, questions, labels and sketches', () => {
  const long = 'x'.repeat(400)
  // The distinguishing character has to fall inside the 40 the label is cut to; two labels that
  // only differ past the cut are twins as far as a reader is concerned, and the gate says so.
  const branches = ok().branches.map((b, i) => ({ ...b, label: i + long, sketch: long }))
  const [d] = gate(ok({ axis: long, question: long, branches }))
  expect(d.axis).toHaveLength(24)
  expect(d.question).toHaveLength(120)
  expect(d.branches[0].label).toHaveLength(40)
  expect(d.branches[0].sketch).toHaveLength(160)
})
