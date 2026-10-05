# Landing asset attribution

## `landing-sky.webp`

- **Subject:** Blue sky with clouds, used as the full-bleed backdrop of the
  public landing hero (`/` for signed-out visitors) only.
- **Photographer:** Sonny Mauricio
- **Photo page:** https://unsplash.com/photos/kIr8e-01eAw
- **Image source:** https://images.unsplash.com/photo-1617150119111-09bbb85178b0
- **License:** Unsplash License — https://unsplash.com/license
- **Downloaded:** 2400 × 1600, converted to WebP, ~354 KiB
- **Stored at:** `frontend/src/assets/landing-sky.webp`

The asset is bundled and served locally. It is imported through
`url('../assets/landing-sky.webp')` in `LandingScreen.module.css`, so Vite emits
a hashed file under the `/static/` build prefix. The runtime never hotlinks the
Unsplash URL. A flat blue tint (`rgba(0, 70, 110, 0.80)` over a `#075986`
fallback) sits over the photo so ordinary white marketing text keeps at least
4.5:1 contrast on the brightest pixels. The floating header reuses the same hue
at `rgba(0, 70, 110, 0.42)` and paints above that hero tint, so the two layers
compound on the header.
