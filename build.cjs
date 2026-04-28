const esbuild = require('esbuild')

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: false,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: 'dist/index.cjs',
})
