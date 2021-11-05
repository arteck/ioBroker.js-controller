module.exports = {
    'env': {
        'es6': true,
        'node': true
    },
    'extends': 'eslint:recommended',
    'rules': {
        'indent': [
            'error',
            4,
            {
                'SwitchCase': 1
            }
        ],
        'curly': 'error',
        'brace-style': 'error',
        'arrow-parens': ['error', 'as-needed'],
        'no-console': 'off',
        'no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'caughtErrors': 'all' }],
        'no-useless-escape': 'warn',
        'no-constant-condition': 'off',
        'no-multiple-empty-lines': ['error', { 'max': 1, 'maxEOF': 1 }],
        'no-var': 'error',
        'prefer-const': 'error',
        'no-throw-literal': 'error',
        'prefer-promise-reject-errors': 'error',
        'require-await': 'error',
        'no-return-await': 'error',
        'eqeqeq': ['error', 'always'],
        'quotes': [
            'error',
            'single',
            {
                'avoidEscape': true,
                'allowTemplateLiterals': true
            }
        ],
        'semi': [
            'error',
            'always'
        ],
        'comma-dangle': ['error', {
            'arrays': 'never',
            'objects': 'never',
            'imports': 'never',
            'exports': 'never',
            'functions': 'ignore'
        }],
        'no-trailing-spaces': 'error'
    },
    'parserOptions': {
        'ecmaVersion': 2019
    },
    'overrides': [ // we need ts parser for ts files
        {
            'files': ['**/*.ts', '**/*.tsx'],
            'extends': ['plugin:@typescript-eslint/recommended']
        }
    ]
};
