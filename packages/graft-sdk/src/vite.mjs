export async function graftUi(options) {
  const { svelte } = await import('@sveltejs/vite-plugin-svelte');
  return {
    plugins: [
      svelte({
        compilerOptions: { css: 'injected' },
        dynamicCompileOptions: ({ filename }) =>
          filename.includes('node_modules') ? undefined : { runes: true }
      }),
      ...(options.plugins ?? [])
    ],
    resolve: { conditions: ['svelte', 'browser', 'production'] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: options.outDir ?? 'dist/ui',
      emptyOutDir: true,
      target: 'es2022',
      minify: 'esbuild',
      cssCodeSplit: false,
      lib: { entry: options.entry, formats: ['es'], fileName: () => 'client.js' },
      rollupOptions: {
        output: {
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      }
    }
  };
}
