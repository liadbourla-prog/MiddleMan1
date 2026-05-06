import type { Skill, SkillContext, SkillOutcome } from '../shared/skill-types.js'
import { businessKnowledgeSetupSkill } from './business-knowledge-setup/index.js'
import { websiteBuilderSkill } from './website-builder/index.js'

export const registry: Skill[] = [
  businessKnowledgeSetupSkill,
  websiteBuilderSkill,
]

export function registerSkill(skill: Skill): void {
  registry.push(skill)
}

/**
 * Finds the first skill that can handle the context and runs it.
 * Returns null if no skill claims the message (core engine handles it normally).
 */
export async function dispatchSkill(ctx: SkillContext): Promise<SkillOutcome | null> {
  for (const skill of registry) {
    if (skill.canHandle(ctx)) {
      const outcome = await skill.handle(ctx)
      if (outcome.handled) {
        console.info(JSON.stringify({
          event: 'skill.dispatched',
          skillName: outcome.skillName,
          businessId: ctx.business.id,
          callerRole: ctx.caller.role,
          sessionComplete: outcome.sessionComplete,
        }))
      }
      return outcome
    }
  }
  return null
}
