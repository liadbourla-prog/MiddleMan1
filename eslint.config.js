// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Enforce the isolation boundary: skills may not reach into the core engine.
    files: ['src/skills/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/domain/**',
                '**/adapters/**',
                '**/db/**',
                '**/workers/**',
                '**/routes/**',
                '**/server*',
                '**/redis*',
              ],
              message:
                'Skills may only import from src/shared/. To expose new data, extend SkillContext in src/shared/skill-types.ts.',
            },
          ],
        },
      ],
    },
  },
)
