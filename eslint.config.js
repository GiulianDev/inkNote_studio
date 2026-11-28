import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'dev-dist/**/*', 'node_modules/**/*', '.playwright-cli/**/*']
  },
  firebaseRulesPlugin.configs['flat/recommended']
];
