import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('Mohr shell', () => {
  it('renders the Mohr brand', () => {
    render(<App />)
    expect(screen.getByRole('link', { name: 'Mohr' })).toBeInTheDocument()
  })
})
