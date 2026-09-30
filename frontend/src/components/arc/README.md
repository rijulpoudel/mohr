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
  `motion.span`, so no `layoutId` projection can run. The absence of an actual
  animation is confirmed in browser/compositor QA, not by unit assertions.
- Keyboard focus is resolved through per-index button refs instead of an
  upstream `CSS.escape` selector.
- Removed upstream's scroll/fade-mask track behavior. A three-option row must
  fit a 320px content width, so the track no longer scrolls or masks edges.
- CSS maps to Mohr variables (`--color-*`, `--radius-md`) with flex segments
  and 44px minimum targets; no global Arc foundation reset is imported.

## Dependency

`motion@13.4.6` is the runtime dependency. Only `motion/react` is used.

## Updating from upstream

Re-read the upstream files at the pinned commit, then port only changes that
match Mohr's reduced API and variables. Do not copy the unused motion token
system, accessory/intent callbacks, or the scroll/fade track. Update the
upstream commit hash above and re-run the focused tests.
