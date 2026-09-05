# Generated previews

This directory stores reviewed preview assets generated from project blueprint
prompts. It is independent from the read-only upstream archive under
`data/source/`.

`manifest.json` records the prompt hash, rendering settings, output checksum,
and review status for every accepted asset. Run:

```bash
python3 scripts/install_generated_previews.py
python3 scripts/install_generated_previews.py --check
```

The installer validates each source WebP before copying it to
`public/previews/`. Do not edit the public copies manually.
