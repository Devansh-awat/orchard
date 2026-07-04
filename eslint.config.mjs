import { configs, plugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default [
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'apps/frontend/.svelte-kit/**',
			'apps/frontend/static/**',
			'apps/gateway/**',
			'apps/server/prisma/**',
			'**/*.config.{js,ts,mjs,cjs}',
			'**/*.d.ts'
		]
	},
	plugins.stylistic,
	plugins.importX,
	plugins.node,
	...configs.base.recommended,
	plugins.typescriptEslint,
	...configs.base.typescript,
	{
		files: ['**/*.ts', '**/*.mts', '**/*.svelte'],
		...tseslint.configs.disableTypeChecked
	},
	...svelte.configs['flat/recommended'],
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
				extraFileExtensions: ['.svelte']
			}
		}
	},
	{
		rules: {
			'import-x/prefer-default-export': 'off',
			'import-x/extensions': 'off',
			'no-restricted-syntax': 'off',
			'no-await-in-loop': 'off',
			'no-plusplus': 'off',
			'no-continue': 'off',
			'class-methods-use-this': 'off',
			'no-underscore-dangle': 'off',
			'max-classes-per-file': 'off',
			'no-console': ['warn', { allow: ['warn', 'error'] }],
			'no-void': ['error', { allowAsStatement: true }],
			'no-param-reassign': ['error', { props: false }],
			'no-empty': ['error', { allowEmptyCatch: true }],
			'no-bitwise': 'off',
			'consistent-return': 'off'
		}
	},
	{
		files: ['**/*.ts', '**/*.mts'],
		rules: {
			'@typescript-eslint/no-use-before-define': ['error', { functions: false }],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
			]
		}
	},
	{
		files: ['apps/frontend/**'],
		rules: {
			'import-x/no-unresolved': 'off',
			'import-x/no-extraneous-dependencies': 'off'
		}
	},
	{
		files: ['apps/server/src/**/*.module.ts'],
		rules: {
			'import-x/no-cycle': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		rules: {
			'no-nested-ternary': 'off',
			'svelte/no-navigation-without-resolve': 'off',
			'svelte/require-each-key': 'warn',
			'svelte/prefer-svelte-reactivity': 'warn',
			'svelte/no-at-html-tags': 'warn'
		}
	},
	prettier
];
