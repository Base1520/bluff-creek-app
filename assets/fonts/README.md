# Locally hosted Homestead fonts

These are the same three Latin WOFF2 files loaded by the existing Google Fonts stylesheet in the website’s Chrome 152 mobile audit. Serving the files through `css/fonts.css` removes the additional Google stylesheet request while preserving the existing families, styles, requested weights, and Latin unicode ranges.

Downloaded on **2026-09-05**. The font binaries are unchanged upstream files: no subsetting, instancing, font-name changes, or other font modification was performed.

| Local file | Family / style | Existing requested weights | Bytes |
| --- | --- | --- | ---: |
| `bitter-latin-normal-v42.woff2` | Bitter / normal | 500, 600, 700 | 34,156 |
| `bitter-latin-italic-500-v42.woff2` | Bitter / italic | 500 | 18,924 |
| `nunito-sans-latin-normal-v19.woff2` | Nunito Sans / normal | 400, 600, 700, 800 | 30,948 |

Total font payload: **84,028 bytes**. Each `@font-face` retains `font-display: swap`. The repeated normal-weight rules share a single local binary per family, matching the upstream CSS. The browser downloads each file only when that face is needed.

## Integration

Load `css/fonts.css` from the generated page head in place of the external Google Fonts stylesheet. Its URLs are relative to the stylesheet and work when the site is hosted under a GitHub Pages project path.

An optional preload for the heading face is:

```html
<link rel="preload" href="assets/fonts/bitter-latin-normal-v42.woff2" as="font" type="font/woff2" crossorigin>
```

Keep the existing CSS family names and font stacks. The current English pages use these Latin subsets; adding another writing system may require its corresponding official upstream subset. Ordinary site builds require no font download or additional dependency.

## Source stylesheet

[Original Google Fonts request](https://fonts.googleapis.com/css2?family=Bitter:ital,wght@0,500;0,600;0,700;1,500&family=Nunito+Sans:wght@400;600;700;800&display=swap)

The stylesheet was fetched with the same network user agent as the mobile audit:

```text
Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36
```

The following source URLs exactly match that audit’s three font requests:

- [Bitter v42 normal Latin WOFF2](https://fonts.gstatic.com/s/bitter/v42/rax8HiqOu8IVPmn7f4xpLjpSmw.woff2)
- [Bitter v42 italic 500 Latin WOFF2](https://fonts.gstatic.com/s/bitter/v42/raxjHiqOu8IVPmn7epZnDMyKBvHf5D6c0vz-X3Byn-ahBg.woff2)
- [Nunito Sans v19 normal Latin WOFF2](https://fonts.gstatic.com/s/nunitosans/v19/pe0TMImSLYBIv1o4X1M8ce2xCx3yop4tQpF_MeTm0lfGWVpNn64CL7U8upHZIbMV51Q42ptCp7t1R-tQKr51.woff2)

## Licenses

Both font families are distributed under the **SIL Open Font License, Version 1.1**. Complete upstream copyright notices and license wording are preserved; trailing whitespace is normalized:

- [Bitter license](OFL-Bitter.txt), from the [official Google Fonts repository](https://github.com/google/fonts/blob/main/ofl/bitter/OFL.txt).
- [Nunito Sans license](OFL-NunitoSans.txt), from the [official Google Fonts repository](https://github.com/google/fonts/blob/main/ofl/nunitosans/OFL.txt).

## SHA-256 checksums

```text
261cfc4d27941b2774efba0a2b03872ddc001dca4423aa3ce278e80301423c1b  bitter-latin-normal-v42.woff2
931de051ab8cae315710a3a4486c2747f5dad4d858a73242bf51e53e96498a03  bitter-latin-italic-500-v42.woff2
39184f4d011106f5bfbe3813d3a8c3673663f04a45a9c9f55b1ed15f4d5b1cc9  nunito-sans-latin-normal-v19.woff2
```
