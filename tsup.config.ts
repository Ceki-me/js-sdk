import { defineConfig } from 'tsup';
import path from 'node:path';

// esbuild `alias` rejects relative-path keys, so swap the Node transports for
// their browser twins with an onResolve plugin instead. This intercepts the
// exact relative/bare specifiers used by the SDK source and redirects them.
function browserTransportPlugin() {
  const PREFIX = path.resolve(process.cwd(), 'src') + path.sep;
  return {
    name: 'ceki-browser-transports',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // Only touch imports that originate from our own src/ tree.
        if (!args.importer.startsWith(PREFIX)) return undefined;
        const req = args.path;
        if (req === 'ws' || req === '@roamhq/wrtc' || req === './webrtc.js') {
          if (req === './webrtc.js' || req === '@roamhq/wrtc') {
            return { path: path.resolve(process.cwd(), 'src/webrtc-browser.ts') };
          }
          return { path: path.resolve(process.cwd(), 'src/ws-browser.ts') };
        }
        return undefined;
      });
    },
  };
}

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    clean: false,
    sourcemap: true,
  },
  {
    // Browser entry — swaps Node transports (`ws`, `@roamhq/wrtc`) for their
    // browser twins via an onResolve plugin. Bundled with the swaps baked in
    // so consumers just import from '@ceki/sdk/browser'.
    name: 'browser',
    entry: { 'browser': 'src/browser-index.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'browser',
    // tsup externals package.json `dependencies` by default — that would keep
    // `ws` and `@roamhq/wrtc` as runtime imports (broken in the browser). Force
    // them in so the onResolve plugin's swap takes effect.
    noExternal: ['ws', '@roamhq/wrtc', 'mime-types'],
    esbuildPlugins: [browserTransportPlugin()],
  },
]);