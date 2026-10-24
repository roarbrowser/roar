# Demo videos

Two site videos, each scripted with a shot list, rap narration and music brief:

| Video | Script | Output |
|---|---|---|
| Developers (Claude Code, Cursor) | [demo-script.md](demo-script.md) | `docs/media/roar-demo.mp4`, `roar-demo-web.mp4`, `roar-demo.jpg` |
| Everyday AI users | [demo-script-everyday.md](demo-script-everyday.md) | `docs/media/roar-everyday.mp4`, `roar-everyday-web.mp4`, `roar-everyday.jpg` |

Four persona drafts (developer, everyday ChatGPT/Claude user, former Arc/Dia user, privacy-minded) were merged by a judge into these two. Arc import was left out of both: it needs a sample Arc profile to film honestly.

## Render (one command each)

Needs Node 22+, Python 3 with numpy, ffmpeg, and a built `build/src/Release/Roar.app` (`bash scripts/build.sh`).

```sh
node scripts/demo/film.mjs docs/launch/demo-script.md            # developer cut
node scripts/demo/film.mjs docs/launch/demo-script-everyday.md   # everyday cut
```

Each run takes about 4 minutes and needs nobody at the keyboard:

1. Starts a headless scratch Roar (`--headless=new`, CDP port 9343, fresh data dir in the temp dir; never 9222, 9444 or `/Applications/Roar.app`). It stops if 9343 is taken, and kills its Roar and demo tmux on exit.
2. Plays the script's `## Machine shot list` (setup, then timed shots) through the bundled MCP server (`roar-mcp.sh`) plus sidebar `ask()` calls and real CDP mouse clicks.
3. Records the sidebar and the active tab with CDP `Page.startScreencast`. No screen capture, so no window ever comes to the front.
4. Renders captions, tool-result panels and the animated end card (lion head, roarbrowser.app) as HTML in that same Roar.
5. Composes with ffmpeg: a default framing that keeps the sidebar readable, eased zooms on cards (`zoom.el` names a sidebar element, measured live), the TEMP beat and TEMP guide vocal with the music ducked under the voice.
6. Writes the 1080p H.264 MP4, a 1280-wide web version under 10 MB, and a JPG poster. It exits non-zero if a step misbehaved or the web file is 10 MB or more. Add `--keep-work` to keep the frames and stems.

`## Film settings` in each script sets the output name, the guide beat (`scripts/demo/beat.py`: style, BPM, key, hit points) and the guide voice: `eleven` is an ElevenLabs premade voice id (developer: Adam, everyday: Jessica), used when `ELEVENLABS_API_KEY` or `~/.config/elevenlabs.key` is set; otherwise macOS `say` reads the lyrics with `voice`. ElevenLabs clips are cached in `~/.cache/roar-film`, so re-renders spend no credits; a line longer than its shot is sped up (at most 1.6x).

`node scripts/demo/run-demo.mjs --auto-answer` is still the quick headless smoke test of the MCP calls.

## Audio is TEMP

Both the beat (synthesized locally by `beat.py`, no samples) and the vocal (ElevenLabs free plan, spoken not rapped; or macOS `say`) are timing guides only. The ElevenLabs free plan is non-commercial and needs attribution, so a paid plan (Starter or above) is required before a voice from it ships in a published video; the end card carries a "TEMP AUDIO" tag. Final music and vocals need licensed or commissioned audio. Never use or upload a copyrighted track. The two videos get different music (developer: dark boom-bap, 90 BPM, D minor; everyday: funk-pop, 108 BPM, A major); see each script's music brief.

## Final audio options (researched 2026-10-17)

These figures come from 2026 comparison and review sites, which often disagree with each other. Confirm each price and license term on the vendor's own page before you buy.

### 1. AI music services

| Service | Cheapest plan for commercial use | Commercial use / ownership | Vocals / rap | Restrictions and litigation |
|---|---|---|---|---|
| Suno | Pro about $10/mo; Premier $30/mo | Paid plans only; free output is personal use with attribution. Sources disagree on ownership: one says paid subscribers get Suno's rights in the output, another says Suno keeps ownership after its WMG deal and you get a license | Yes, full vocals and rap; the strongest of these for rap | Lawsuit with Sony Music still open (summary-judgment hearing July 2026; I found no outcome) |
| Udio | Pro $30/mo (Standard $10/mo has no commercial rights) | Pro only | Yes | **Downloads disabled since 2025-10-29** while the licensed platform with UMG, WMG, Merlin and Kobalt is built. Not usable for now |
| ElevenLabs Music | Starter about $5–6/mo | Commercial use on paid plans; one source says even the free plan allows it with credit to Eleven Music. Film, TV, radio and games need Enterprise. Music v2 (May 2026) was trained on licensed data | Yes, vocals | The cleanest licensing story of the vocal tools |
| Stable Audio | Pro $11.99/mo | Paid plans only; Enterprise terms if company revenue is over $1M | Mainly instrumental | — |
| Mubert | Creator about $12–14/mo, Business $199/mo | No clear ownership terms found | Instrumental | — |
| Soundraw | about $11–17/mo | Commercial use on all paid plans | Instrumental | — |
| Beatoven.ai | about $6–10/mo | Perpetual license for downloads, no Content ID claims | Instrumental | — |
| AIVA | Pro about €33–49/mo | Pro gives full copyright ownership | Instrumental | — |

### 2. Royalty-free libraries

| Library | Price | Scope for web and social ads |
|---|---|---|
| Artlist | about $10–90/mo billed yearly | Pro license covers commercial use including broadcast; you get a downloadable license PDF |
| Epidemic Sound | about $10–20/mo | Creator plan is personal channels only. Pro is needed for commercial or client work; broadcast needs Pro Plus (custom price) |
| Musicbed | about $13–30/mo | Personal and social subscriptions; commercial and sync licenses are quoted per project |
| Envato Elements | about $16.50/mo yearly | Commercial use, including client projects |
| Uppbeat | free tier; paid about $5.59–6.99/mo | Free tier is limited and needs credit; paid plan covers commercial use |
| Pond5 | per track | Not researched |
| YouTube Audio Library / Pixabay | free | Not researched; check that the terms allow paid ads |

### 3. Hiring a rapper or producer

| Option | Typical price (60 s ≈ one 16-bar verse) | Rights |
|---|---|---|
| Lyrics only (AirGigs, SoundBetter) | $45–75 | Text only, no recording |
| Recorded custom verse (Fiverr, AirGigs) | $80–250 | Many sellers keep a writer share or ask for 50/50 splits. Full rights are a higher tier |
| SoundBetter pro (e.g. a London rapper) | about $200 per verse | 50/50 splits and publishing unless you negotiate otherwise |
| Custom beat plus buyout | not found in my searches; usually a few hundred dollars for an exclusive | Get an exclusive license or work-for-hire agreement |
| Voices.com, local artists | not researched | — |

For commercial ads, budget roughly $300–800 per video for verse plus beat with a written work-for-hire buyout. That range is my estimate, not a sourced figure.

### Recommendation
- **Instrumental only:** use Artlist or Envato Elements (one month at about $10–17 covers both videos, with a license PDF), or Beatoven or Soundraw if you want AI-made music. These are the cheapest options with clear terms.
- **AI rap vocals:** use ElevenLabs Music (licensed training data, commercial use from the lowest paid tier) and keep a copy of the terms page from the day you generate. Suno raps better, but its ownership terms are disputed and the Sony lawsuit is still open, so treat it as a demo tool for ads on your own brand. Skip Udio, since it has no downloads.
- **Final rap for a brand:** hire a rapper on SoundBetter or Fiverr for a recorded 16-bar verse ($150–250) and require a written **work-for-hire / full buyout**, including a waiver of their writer share, before paying. Do the same for an exclusive beat. This is the only option here that gives a human performance and clear ownership.

Sources: [rework](https://resources.rework.com/tools/ai-tools/best-ai-music-generators-2026), [teamday](https://www.teamday.ai/blog/best-ai-music-models-2026), [gudz.ai](https://gudz.ai/posts/ai-music-generation-2026), [chartlex](https://www.chartlex.com/blog/marketing/suno-vs-udio-2026), [musicwave](https://www.musicwave.ai/blog/suno-vs-elevenlabs), [omidsaffari](https://omidsaffari.com/blog/best-ai-music-generator), [fast.io](https://fast.io/resources/suno-alternatives-2026/), [costbench Stable Audio](https://costbench.com/software/ai-music-generators/stable-audio/), [costbench AIVA vs Soundraw](https://www.costbench.com/compare/aiva-vs-soundraw/), [magichour](https://magichour.ai/blog/best-ai-music-generators-for-video-ads), [Epidemic blog](https://www.epidemicsound.com/blog/artlist-vs-epidemic-sound/), [soundstripe](https://www.soundstripe.com/blogs/artlist-alternatives), [creatoraidaily](https://www.creatoraidaily.com/blog/epidemic-sound-vs-artlist-vs-musicbed-youtube-creators-2026/), [fluxnote](https://fluxnote.io/guides/epidemic-sound-vs-artlist-2026), [checkthat Uppbeat](https://checkthat.ai/brands/uppbeat/pricing), [toolsurf](https://www.toolsurf.com/epidemic-sound-pricing-2026-plans-costs-royalty-free-music-guide-2026-plans-features-best-deals-compared/), [SoundBetter UK rapper](https://soundbetter.com/profiles/358157-uk-rapper), [AirGigs $250](https://www.airgigs.com/hire-rappers/5223/Elite-Rap-Vocals), [AirGigs $80](https://www.airgigs.com/hire-rappers/97788/ELITE-Rap-Verses-for-your-song), [AirGigs $180](https://www.airgigs.com/hire-rappers/99255/UK-Rap-Drill-Grime-Trap--Hip-Hop-Feature-Verse-andor-Hook), [Fiverr gig](https://fiverr.com/zeeworldwide/write-and-record-custom-rap-vocals-for-your-song)

Not checked: I did not open any vendor's own terms page, and I found nothing on Pond5, YouTube Audio Library, Pixabay, Voices.com, local artists or custom-beat prices. Ownership terms for Suno and Mubert are unclear in the sources I found.