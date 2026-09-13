import { describe, expect, it } from 'vitest'
import viteConfig from './vite.config'

describe('vite dev proxy', () => {
  it('proxies /api to the Django backend while preserving the browser Host', () => {
    const proxy = viteConfig.server?.proxy as Record<string, unknown> | undefined
    expect(proxy?.['/api']).toEqual({
      target: 'http://127.0.0.1:8000',
      changeOrigin: false,
    })
  })
})
