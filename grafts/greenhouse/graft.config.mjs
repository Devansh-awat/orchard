import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const CSS_PREFIX = '\0graft-css:';

function injectCss() {
  return {
    name: 'greenhouse-inject-css',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer.startsWith(CSS_PREFIX)) return null;
      if (source.includes('?') || !source.endsWith('.css')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return null;
      return `${CSS_PREFIX}${resolved.id}.js`;
    },
    load(id) {
      if (!id.startsWith(CSS_PREFIX)) return null;
      const file = id.slice(CSS_PREFIX.length, -'.js'.length);
      return [
        `import css from ${JSON.stringify(`${file}?inline`)};`,
        "if (typeof document !== 'undefined') {",
        "  const style = document.createElement('style');",
        "  style.dataset.graft = 'greenhouse';",
        '  style.textContent = css;',
        '  document.head.appendChild(style);',
        '}',
        'export default css;'
      ].join('\n');
    }
  };
}

function emitWasm() {
  return {
    name: 'greenhouse-emit-wasm',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('.wasm?url')) return null;
      const file = id.slice(0, -'?url'.length);
      const ref = this.emitFile({
        type: 'asset',
        name: basename(file),
        source: readFileSync(file)
      });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    }
  };
}

function islandBuild() {
  return {
    name: 'greenhouse-island-build',
    config: () => ({
      base: './',
      worker: { format: 'es' },
      resolve: { conditions: ['production'] }
    })
  };
}

export default {
  server: {
    external: ['pg']
  },
  ui: {
    plugins: [islandBuild(), injectCss(), emitWasm()]
  }
};
