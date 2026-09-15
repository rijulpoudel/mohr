import { describe, expect, it } from 'vitest'
import viteConfig from './vite.config'

describe('vite dev proxy', () => {
  it('proxies /api to the Django backend while preserving the browser Host', () => {
    const config = viteConfig({ command: 'serve', mode: 'development' })
    const proxy = config.server?.proxy as Record<string, unknown> | undefined
    expect(proxy?.['/api']).toEqual({
      target: 'http://127.0.0.1:8000',
      changeOrigin: false,
    })
  })

  it('serves the SPA from the root base in development', () => {
    const config = viteConfig({ command: 'serve', mode: 'development' })
    expect(config.base).toBe('/')
  })

  it('builds assets under the Django static prefix', () => {
    const config = viteConfig({ command: 'build', mode: 'production' })
    expect(config.base).toBe('/static/')
  })
})
