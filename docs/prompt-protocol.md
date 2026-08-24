# OnePic Prompt Protocol

## Purpose

Legacy image prompts often contain hard-coded subjects, brands, places, text, aspect ratios, multiple input requirements, and example variables. Copying them directly causes the model to ignore the user's uploaded image.

The OnePic protocol turns each legacy prompt into a single-reference-image transformation template.

## Priority model

Every compiled prompt declares:

1. **Image content priority** — the uploaded image controls people, products, objects, setting, text, and narrative.
2. **Visual blueprint priority** — the extracted prompt controls visual language, layout, materials, lighting, and finish.
3. **Common override priority** — shared rules override fixed ratios, sample identities, sample brands, sample titles, and missing-input requirements.

## Automatic fields

All legacy placeholders are treated as automatic:

```text
[COUNTRY]
{TITLE}
<PRODUCT>
ALL_CAPS_VARIABLE
```

The rendering model must infer them from the uploaded image, never ask the user to fill them, and never display the placeholder itself.

## Aspect ratio

The uploaded image ratio is authoritative. A blueprint's `9:16`, `4:5`, `1:1`, `16:9`, or fixed pixel size is ignored.

Multi-panel templates must fit their panel system inside the uploaded ratio.

## Text behavior

Text-heavy categories may generate minimal copy. The rules are:

- preserve central, legible source text when appropriate;
- use the language visible in the image;
- otherwise use the template's detected default language;
- do not copy sample slogans, prices, brands, dates, or statistics;
- do not fabricate long articles or factual claims;
- never show prompt syntax or placeholders.

## Category safeguards

- **Infographic:** observable facts only; no invented statistics.
- **Product:** preserve actual design; no invented claims or prices.
- **People:** preserve identity, clothing, anatomy, and consistency.
- **Architecture:** preserve perspective and structural relationships.
- **UI:** create a generic, legally distinct interface.
- **Brand:** derive a new system rather than copying sample trademarks.
- **Document:** short editorial copy only.

## Output behavior

Every template requests one finished image and prohibits analysis, prompt text, alternatives, or process notes.
