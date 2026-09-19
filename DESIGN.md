---
version: alpha
name: Mohr Warm Wealth
description: A warm, precise personal-finance interface that makes monthly money decisions feel calm and understandable.
colors:
  primary: "#A33900"
  primary-bright: "#FA580C"
  secondary: "#006C49"
  tertiary: "#006194"
  neutral: "#0F172A"
  background: "#F8F7FC"
  surface: "#FFFFFF"
  surface-muted: "#F1F2FB"
  text-muted: "#6B5A54"
  border: "#E8E4E8"
  error: "#BA1A1A"
typography:
  display:
    fontFamily: Plus Jakarta Sans
    fontSize: 2.25rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  heading-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.75rem
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  heading-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: Plus Jakarta Sans
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Plus Jakarta Sans
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1.4
  caption:
    fontFamily: Plus Jakarta Sans
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: 6px
  md: 10px
  lg: 16px
  pill: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 12px
    height: 44px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.neutral}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 12px
    height: 44px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.lg}"
    padding: 24px
  nav-active:
    backgroundColor: "#FFE0D2"
    textColor: "{colors.neutral}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
  field:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.neutral}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 44px
  caption:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
  divider:
    backgroundColor: "{colors.border}"
    textColor: "{colors.neutral}"
    size: 1px
---

## Overview

Mohr should feel warm, calm, trustworthy, and exact. The interface combines the restraint of a professional finance product with a personal visual identity. It is dense enough to answer real questions without turning every value into a card.

The product promise controls the hierarchy: help students and young professionals understand where their money went and what they can safely spend this month.

## Colors

- **Action orange (`#A33900`)** is the accessible high-emphasis interaction color. Use it for one primary action per region, active navigation details, and critical chart emphasis.
- **Bright orange (`#FA580C`)** is a brand and illustration color. Do not place normal-size white text on it.
- **Emerald (`#006C49`)** communicates positive financial outcomes such as income, remaining funds, and healthy progress. Never rely on color alone.
- **Blue (`#006194`)** identifies neutral analytical information. It is not a second call-to-action color.
- **Deep navy (`#0F172A`)** is the primary text color and anchors the identity.
- Warm lavender-gray backgrounds separate the application canvas from flat white working surfaces.
- Error red is reserved for destructive actions, invalid input, and overspending. Do not use orange as an error color.

Charts use the smallest meaningful palette. Categories must also have labels or direct values so color is never the only key.

## Typography

Use Plus Jakarta Sans for interface text and financial figures. Monetary values use tabular numerals. Headings stay compact and sentence case. Avoid oversized marketing typography inside authenticated product screens.

Use no more than three visible weights on one screen. Small uppercase labels are allowed only for compact metric labels and must retain readable letter spacing.

## Layout

- Desktop uses a persistent left navigation rail and a flexible main workspace.
- Mobile uses a compact top bar and an explicit menu control. Navigation must not force horizontal scrolling.
- Main content uses a 12-column mental model but may collapse to one column at narrow widths.
- Prefer a few large working regions over card-inside-card nesting.
- Every interactive target is at least 44 by 44 pixels.
- Monetary columns align to the end and use tabular numerals.
- Empty, loading, error, and synchronization states occupy the same structural region as loaded content to minimize layout shifts.

## Elevation & Depth

Use flat backgrounds, borders, and subtle tonal separation. Shadows are optional and must be barely perceptible. Do not use glassmorphism, blur, glow, or neon treatments.

## Shapes

Cards use a 16px radius. Controls use 10px or pill radii according to function. Status chips may use pill shapes. Do not make every container a pill.

The ornamental Mohr seal may appear in full on onboarding or marketing surfaces. Product navigation uses a simplified flat mark that remains recognizable at 16px and 32px.

## Components

- One filled primary button wins each action group.
- Secondary actions use white or transparent surfaces with visible borders.
- Active navigation uses a warm tinted field, dark text, and an additional non-color indicator through weight or icon treatment.
- Metric cards explain period and meaning. They never relabel `total_balance` as historical net worth.
- Charts require a title phrased as a financial question or a label that clearly states the measure and period.
- Tables retain visible focus, keyboard operation, aligned amounts, and responsive alternatives rather than hiding required columns without explanation.

## Do's and Don'ts

### Do

- Use real Mohr API fields and document each calculation.
- Prioritize safe-to-spend, income, spending, budget health, accounts, and recent activity.
- Pair positive, warning, and error colors with labels or icons.
- Test realistic long labels, negative values, and large monetary strings.
- Preserve session authentication, CSRF behavior, ownership isolation, and provider pending states.

### Don't

- Fabricate net-worth history, investments, property, vehicles, mortgages, goals, or recurring bills.
- Import generated Stitch HTML directly into React.
- Use gradients, glow, rainbow charts, hidden scrollbars, or decorative financial graphs.
- Display placeholder zeroes as real balances while a Plaid account is awaiting its anchor.
- Shrink controls below 44px to make a dense layout fit.
