import { describe, it, expect } from 'vitest'
import { nextApprovalStatus } from './approvals.js'
import type { ApprovalStatus, ResolveDecision } from './approvals.js'

// The owner-confirm gate's pure core (mirrors initiations/gate.test.ts and
// coordination/state.ts): the only genuinely-pure decision in approvals.ts is the
// status-transition guard. The DB-backed proposeInitiation / resolveInitiationProposal are
// integration-level (the repo has no DB test harness); their I/O contract is documented in
// the block comment below so the behaviour is pinned even though it isn't exercised here.
//
// I/O contract pinned for proposeInitiation:
//   - recipient.messagingOptOut === true            → 'recipient_opted_out' (never proposed)
//   - insert onConflictDoNothing, 0 rows back        → 'duplicate' (owner not re-nagged)
//   - fresh insert                                   → notify owner + audit → 'proposed'
// I/O contract pinned for resolveInitiationProposal:
//   - status !== 'pending'                           → { ok:false, outcome:'not_pending' } (idempotent)
//   - decline                                        → status='declined' + audit → { ok:true, 'declined' }
//   - approve + in-window                            → phrase + send + initiation_log row + audit → 'sent'
//   - approve + out-of-window (no ai_proposed tmpl)  → status='approved', no send → 'unreachable'

const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'declined', 'expired']
const DECISIONS: ResolveDecision[] = ['approve', 'decline']

describe('nextApprovalStatus — owner-confirm transition guard', () => {
  it('pending + approve → approved', () => {
    expect(nextApprovalStatus('pending', 'approve')).toEqual({ ok: true, next: 'approved' })
  })

  it('pending + decline → declined', () => {
    expect(nextApprovalStatus('pending', 'decline')).toEqual({ ok: true, next: 'declined' })
  })

  it('non-pending statuses are rejected for both decisions (idempotent guard)', () => {
    const nonPending: ApprovalStatus[] = ['approved', 'declined', 'expired']
    for (const status of nonPending) {
      for (const decision of DECISIONS) {
        expect(nextApprovalStatus(status, decision)).toEqual({ ok: false })
      }
    }
  })

  it('full truth table: only pending admits a transition', () => {
    for (const status of STATUSES) {
      for (const decision of DECISIONS) {
        const result = nextApprovalStatus(status, decision)
        if (status === 'pending') {
          expect(result).toEqual({ ok: true, next: decision === 'approve' ? 'approved' : 'declined' })
        } else {
          expect(result).toEqual({ ok: false })
        }
      }
    }
  })
})
