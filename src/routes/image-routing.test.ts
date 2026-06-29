import { describe, it, expect } from 'vitest'
import { classifyImageMessage } from './image-routing.js'

describe('classifyImageMessage (INJ6)', () => {
  // When an image-skill can consume the image, always upload — regardless of caption.
  it('uploadable=true, caption=true → upload_for_skill', () => {
    expect(classifyImageMessage({ imageSkillUploadable: true, hasCaption: true })).toBe('upload_for_skill')
  })
  it('uploadable=true, caption=false → upload_for_skill', () => {
    expect(classifyImageMessage({ imageSkillUploadable: true, hasCaption: false })).toBe('upload_for_skill')
  })

  // No skill consumes the image, but a caption carries the intent → route as text (the bug fix).
  it('uploadable=false, caption=true → route_caption_as_text', () => {
    expect(classifyImageMessage({ imageSkillUploadable: false, hasCaption: true })).toBe('route_caption_as_text')
  })

  // No skill, no caption → genuinely nothing to act on → bounce.
  it('uploadable=false, caption=false → bounce_non_text', () => {
    expect(classifyImageMessage({ imageSkillUploadable: false, hasCaption: false })).toBe('bounce_non_text')
  })
})
