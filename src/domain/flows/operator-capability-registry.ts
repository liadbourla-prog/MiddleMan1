/**
 * Maps each registered skill to the operator commands that surface its state.
 *
 * When a new skill is added to src/skills/index.ts, this registry must also be
 * updated — the CI test in operator-capability-registry.test.ts enforces this.
 * Developer A owns this file. Developer B is responsible for flagging when a new
 * skill needs additional operator visibility beyond what is listed here.
 */

export interface SkillOperatorCapabilities {
  skillName: string
  /** Which operator commands expose this skill's state. */
  statusCommands: string[]
  /** True if this skill calls ctx.deferFeatureRequest() — surfaced by FEATURES command. */
  writesFeatureRequests: boolean
  /** True if RETRIGGER applies (workflow skill with a known re-entry step). */
  retriggerable: boolean
  retriggersFirstStep?: string
}

export const operatorCapabilityRegistry: SkillOperatorCapabilities[] = [
  {
    skillName: 'business-knowledge-setup',
    statusCommands: ['STATUS [business]', 'SKILLS [business]'],
    writesFeatureRequests: true,
    retriggerable: true,
    retriggersFirstStep: 'brand-voice',
  },
  {
    skillName: 'website-builder',
    statusCommands: ['SKILLS [business]'],
    writesFeatureRequests: false,
    retriggerable: true,
    retriggersFirstStep: 'requirements-gather',
  },
]

export const registeredSkillNames: string[] = operatorCapabilityRegistry.map((c) => c.skillName)
