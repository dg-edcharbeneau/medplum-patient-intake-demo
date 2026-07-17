// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/* global process */
/* global console */
/*eslint no-process-exit: "off"*/

import botLayer from '@medplum/bot-layer/package.json' with { type: 'json' };
import esbuild from 'esbuild';
import fastGlob from 'fast-glob';

// Find all TypeScript files in your source directory
const entryPoints = fastGlob.sync('./src/**/*.ts').filter((file) => !file.endsWith('test.ts'));

const botLayerDeps = Object.keys(botLayer.dependencies);

// Define the esbuild options
const esbuildOptions = {
  entryPoints: entryPoints,
  bundle: true, // Bundle imported functions
  minify: true, // Shrink output so the deploy bundle stays under the server's maxJsonSize
  outdir: './dist', // Output directory for compiled files
  platform: 'node',
  loader: {
    '.ts': 'ts', // Load TypeScript files
  },
  // Include JS extensions so bundled npm deps (e.g. @aws-sdk/client-bedrock-runtime) resolve.
  resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
  external: botLayerDeps,
  // Medplum's vmcontext runtime evaluates bot code as CommonJS; ESM output throws
  // "Unexpected token 'export'". CJS works for both vmcontext and awslambda.
  format: 'cjs',
  // vmcontext calls `exports.handler(...)` off a `const exports = {}`, but esbuild's CJS
  // output reassigns `module.exports`, leaving that `exports` without `handler`. Copy it back.
  footer: {
    js: 'if (typeof module !== "undefined" && module.exports && module.exports.handler && typeof exports !== "undefined") { exports.handler = module.exports.handler; }',
  },
  target: 'es2020', // Set the target ECMAScript version
  tsconfig: 'tsconfig.json',
};

// Build using esbuild
esbuild
  .build(esbuildOptions)
  .then(() => {
    console.log('Build completed successfully!');
  })
  .catch((error) => {
    console.error('Build failed:', JSON.stringify(error, null, 2));
    process.exit(1);
  });
