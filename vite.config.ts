import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import type { OutputChunk } from 'rollup'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function offlineAssetManifest(): Plugin {
  return {
    name: 'offline-asset-manifest',
    apply: 'build' as const,
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle)
      const chunks = entries.filter((item): item is OutputChunk => item.type === 'chunk')
      const assets = entries.flatMap((item) => {
        if (item.type === 'chunk') return item.facadeModuleId?.replaceAll('\\', '/').includes('/features/ai-help/') ? [] : [item.fileName]
        return /\.(?:css|svg|png|ico|webmanifest|woff2?)$/i.test(item.fileName) ? [item.fileName] : []
      }).sort()
      const routeModules = chunks
        .filter((item) => {
          const moduleId = item.facadeModuleId?.replaceAll('\\', '/')
          return Boolean(item.isDynamicEntry && moduleId && moduleId.includes('/src/features/') && !moduleId.includes('/features/ai-help/'))
        })
        .map(({ fileName }) => fileName)
        .sort()
      const chunksByFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
      const routeDependencies = new Set<string>()
      const visitImports = (fileName: string) => {
        if (routeDependencies.has(fileName)) return
        routeDependencies.add(fileName)
        const chunk = chunksByFile.get(fileName)
        for (const imported of chunk?.imports ?? []) visitImports(imported)
      }
      for (const fileName of routeModules) visitImports(fileName)
      this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify({ assets, routeModules: [...routeDependencies].sort() }) })
    },
  }
}

export default defineConfig({
  base: '/ProgressTracker/',
  plugins: [react(), tailwindcss(), offlineAssetManifest()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    maxWorkers: 2,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.idea/**', '**/.git/**', '**/.cache/**', 'e2e/**'],
  },
})
