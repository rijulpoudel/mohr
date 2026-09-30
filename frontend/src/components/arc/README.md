# Arc SegmentedControl (local adaptation)

`SegmentedControl.tsx` and `SegmentedControl.module.css` are a locally owned
adaptation of the MIT-licensed Arc registry component.

## Provenance

- Upstream: Arc registry `registry/components/segmented-control/`
- Upstream commit: `cde1b4031f6e76f08f1e3da8510e6b952d087069`
- License: MIT, copyright (c) 2026 Elia Kuratli (see `LICENSE` in this folder)

## What was kept

- `LayoutGroup` + `useId` scoping so each rendered control owns its animated
  highlight identity.
- `motion` shared-layout selection (`layoutId="selection"`,
  `layoutDependency={value}`) and `useReducedMotion`.
- Arrow/Home/End selection semantics with a single selected tab stop.

## Deliberate adaptations

- API is reduced to what Mohr needs: readonly `options` with `value`/`label`,
  controlled `value`, `onValueChange`, required `label`, `disabled`, and
  optional `className`. Upstream `accessory` and `onOptionIntent` were dropped
  as speculative.
- The motion spring token `{ type: 'spring', visualDuration: 0.42, bounce: 0.16 }`
  is inlined instead of importing Arc's full `motion-tokens.ts`.
- Under reduced motion the selected branch renders a plain static
  `<span className={styles.selection} aria-hidden="true" />` instead of a
  `motion.span`, so no `layoutId` projection can run. Unit tests pin this with a
  partial `motion/react` mock that overrides `useReducedMotion` and wraps the
  real `motion.span` to count animated renders, while keeping the real
  `LayoutGroup` and layout renderer; the reduced test asserts the animated
  branch never renders. Actual animation smoothness still needs
  browser/compositor QA.
- Keyboard focus is resolved through per-index button refs instead of an
  upstream `CSS.escape` selector.
- The single tab stop is derived from the resolved `selectedIndex`, so a
  controlled value that matches no option still leaves the first option
  keyboard-reachable even though no option reports `aria-pressed="true"`.
- Removed upstream's scroll/fade-mask track behavior. A three-option row must
  fit a 320px content width, so the track no longer scrolls or masks edges.
- CSS maps to Mohr variables (`--color-*`, `--radius-md`). Segments size to
  their label content (`flex: 1 0 auto`, 8px horizontal padding) instead of
  equal `flex-basis: 0` cells, so no label ellipsizes at 320px, with 44px
  minimum targets. The root fills its form-field column like the native
  selects; no global Arc foundation reset is imported.

## Dependency

`motion@13.4.6` is the runtime dependency. Only `motion/react` is used.

## Updating from upstream

Re-read the upstream files at the pinned commit, then port only changes that
match Mohr's reduced API and variables. Do not copy the unused motion token
system, accessory/intent callbacks, or the scroll/fade track. Update the
upstream commit hash above and re-run the focused tests.
