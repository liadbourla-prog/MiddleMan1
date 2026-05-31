// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Honor the `_`-prefix convention for intentionally-unused bindings
    // (e.g. destructure-to-omit: `const { key: _omit, ...rest } = obj`).
    // Scoped to the core tree; src/skills/ lint behavior is left untouched
    // (Developer B's domain — see CODEOWNERS).
    files: [
      'src/domain/**/*.ts',
      'src/adapters/**/*.ts',
      'src/workers/**/*.ts',
      'src/routes/**/*.ts',
      'src/db/**/*.ts',
      'src/shared/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
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
