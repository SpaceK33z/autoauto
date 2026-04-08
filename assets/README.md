# Assets

## Diagram animation (`autoauto_diagram.py`)

Manim Community Edition source for the README diagram animation. Made with [/manim-video](https://github.com/NousResearch/hermes-agent/tree/main/skills/creative/manim-video)

### Prerequisites

```bash
uv tool install manim --python 3.13
brew install texlive dvisvgm ffmpeg
```

### Render

```bash
# Draft (fast, 480p)
manim -ql assets/autoauto_diagram.py AutoAutoLoop

# Production (720p)
manim -qm assets/autoauto_diagram.py AutoAutoLoop
```

### Convert to GIF

```bash
ffmpeg -y -i media/videos/autoauto_diagram/720p30/AutoAutoLoop.mp4 \
  -vf "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 assets/autoauto_diagram.gif
```

Output: `assets/autoauto_diagram.gif`
