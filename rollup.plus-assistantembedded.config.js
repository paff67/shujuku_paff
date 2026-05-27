import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import vuePlugin from 'unplugin-vue/rollup';
import sfcStyleInjector from './src/presentation-v2/build/rollup-sfc-style-injector.js';
import vueScriptTranspiler from './src/presentation-v2/build/rollup-vue-script-transpiler.js';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createTsPlugin() {
  return typescript({
    tsconfig: './tsconfig.json',
    compilerOptions: {
      noEmit: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      outDir: 'dist/plus-assistantembedded',
    },
    include: ['src/**/*.ts', 'src/**/*.js'],
  });
}

const config = {
  input: 'src/entry-extension-plus-assistantembedded.ts',
  output: {
    file: 'dist/plus-assistantembedded/index.js',
    format: 'es',
    sourcemap: false,
  },
  treeshake: false,
  plugins: [
    {
      name: 'node-builtins-shim',
      resolveId(source) {
        if (source === 'fs' || source === 'node:fs') {
          return { id: '\0shim:fs', moduleSideEffects: false };
        }
        if (source === 'crypto' || source === 'node:crypto') {
          return { id: '\0shim:crypto', moduleSideEffects: false };
        }
        return null;
      },
      load(id) {
        if (id === '\0shim:fs') {
          return 'export default {}; export const readFileSync = () => null;';
        }
        if (id === '\0shim:crypto') {
          return 'export default {}; export const randomFillSync = (buf) => { for(let i=0;i<buf.length;i++) buf[i]=Math.random()*256|0; return buf; };';
        }
        return null;
      },
    },
    vuePlugin({
      isProduction: true,
      root: process.cwd(),
      sourceMap: false,
      inlineTemplate: false,
    }),
    vueScriptTranspiler(),
    sfcStyleInjector(),
    nodeResolve({
      browser: true,
      preferBuiltins: false,
      extensions: ['.mjs', '.js', '.json', '.ts', '.vue'],
    }),
    commonjs(),
    createTsPlugin(),
    replace({
      preventAssignment: true,
      values: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      },
    }),
    {
      name: 'copy-plus-assistantembedded-manifest',
      writeBundle() {
        try {
          mkdirSync(join(__dirname, 'dist', 'plus-assistantembedded'), { recursive: true });
          copyFileSync(
            join(__dirname, 'manifest.plus-assistantembedded.json'),
            join(__dirname, 'dist', 'plus-assistantembedded', 'manifest.json'),
          );
        } catch (e) {
          console.warn('复制 plus-assistantembedded manifest 失败:', e.message);
        }
      },
    },
  ],
  external: [
    './script.js',
    './scripts/extensions.js',
  ],
  onwarn(warning, warn) {
    if (warning.code === 'THIS_IS_UNDEFINED') return;
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    warn(warning);
  },
};

export default config;
