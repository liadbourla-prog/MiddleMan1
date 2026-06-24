import { describe, it, expect } from 'vitest'
import { allocateBudget } from './budget.js'
import type { BudgetCandidate } from './budget.js'

describe('allocateBudget', () => {
  it('§4.4 contention: highest score wins, rest deferred, input order preserved', () => {
    const candidates: BudgetCandidate[] = [
      { id: 'a', priority: 30, expValue: 1 },
      { id: 'b', priority: 80, expValue: 1 },
      { id: 'c', priority: 50, expValue: 1 },
      { id: 'd', priority: 70, expValue: 1 },
    ]
    const result = allocateBudget(candidates, 0, 1)
    expect(result).toEqual([
      { id: 'a', admit: false, reason: 'budget_exhausted' },
      { id: 'b', admit: true },
      { id: 'c', admit: false, reason: 'budget_exhausted' },
      { id: 'd', admit: false, reason: 'budget_exhausted' },
    ])
  })

  it('single candidate, alreadySpent=0, budget=1 → admitted', () => {
    const result = allocateBudget([{ id: 'x', priority: 50, expValue: 1 }], 0, 1)
    expect(result).toEqual([{ id: 'x', admit: true }])
  })

  it('single candidate, alreadySpent=1, budget=1 → deferred (rolling-counter case)', () => {
    const result = allocateBudget([{ id: 'x', priority: 50, expValue: 1 }], 1, 1)
    expect(result).toEqual([{ id: 'x', admit: false, reason: 'budget_exhausted' }])
  })

  it('alreadySpent > budget → all deferred', () => {
    const result = allocateBudget(
      [
        { id: 'a', priority: 80, expValue: 1 },
        { id: 'b', priority: 50, expValue: 1 },
      ],
      3,
      1,
    )
    expect(result).toEqual([
      { id: 'a', admit: false, reason: 'budget_exhausted' },
      { id: 'b', admit: false, reason: 'budget_exhausted' },
    ])
  })

  it('budget=0 → all deferred', () => {
    const result = allocateBudget(
      [
        { id: 'a', priority: 80, expValue: 1 },
        { id: 'b', priority: 50, expValue: 1 },
      ],
      0,
      0,
    )
    expect(result).toEqual([
      { id: 'a', admit: false, reason: 'budget_exhausted' },
      { id: 'b', admit: false, reason: 'budget_exhausted' },
    ])
  })

  it('tie on score → stable by input order (admit the earlier one when budget=1)', () => {
    const result = allocateBudget(
      [
        { id: 'first', priority: 50, expValue: 1 },
        { id: 'second', priority: 50, expValue: 1 },
      ],
      0,
      1,
    )
    expect(result).toEqual([
      { id: 'first', admit: true },
      { id: 'second', admit: false, reason: 'budget_exhausted' },
    ])
  })

  it('expValue differentiates: equal priority, higher expValue wins', () => {
    const result = allocateBudget(
      [
        { id: 'low', priority: 50, expValue: 1 },
        { id: 'high', priority: 50, expValue: 3 },
      ],
      0,
      1,
    )
    expect(result).toEqual([
      { id: 'low', admit: false, reason: 'budget_exhausted' },
      { id: 'high', admit: true },
    ])
  })

  it('empty candidates → empty result', () => {
    expect(allocateBudget([], 0, 1)).toEqual([])
  })
})
