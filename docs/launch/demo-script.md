# Roar: "Build it in the browser" (hero video)

**Output:** `docs/media/roar-hero.mp4` (16:9, 1920x1080) and `roar-hero-web.mp4` (1280 wide). It is not swapped into the site until approved.

**Logline:** Someone is building a lion app by describing it. Their agent writes it and opens it in a real Roar tab. Then it tests the app itself: it clicks the roar button and drags the day/night slider, all in the browser, in plain sight. It asks before shipping, and reports when it's done.

**Runtime:** 51 s: 46 s of action plus a 5 s end card. Spoken voiceover from the builder's point of view, not rap.

**Viewer:** anyone who builds with an AI agent. No brands: the assistant is "my agent", and the app ("Lion Den") and all its art are original (`scripts/demo/sites/lion-app/app.html`).

**Staged build:** the agent's code edits are stand-ins. A `stage` action swaps in the next version of the app (STAGE 1-4) at the moment the prompt is sent. Everything in the browser is real Roar: new tabs, reloads, scripted clicks and the slider driven through MCP, plus the ask and done cards.

## Film settings

```json
{"output":"roar-hero","serve":"lion-app","music":{"style":"funk","bpm":100,"key":"E","hits":[9,18,27,32,40,46],"prompt":"Modern cinematic electronic underscore for a tech product launch film, 100 bpm, warm analog synth pulse, deep sub bass, tight minimal drums, subtle African percussion textures (shaker, frame drum), building confidence, a short drop out around 13 seconds then a big swell, polished and premium, instrumental, no vocals"},"sfx":[{"t":14.3,"text":"A single powerful male lion roar, close and loud, deep resonant chest, natural outdoor savanna ambience, cinematic","secs":3.5}],"voice":"Samantha","eleven":"ScZQf6C8aVzMf60NZQVk","poster":34}
```

## Machine shot list

Run by film.mjs: `ROAR_UI_CDP=1 ROAR_CDP_PORT=9343`, a fresh data dir, `--headless=new`, CDP screencast only. The demo site is served on 127.0.0.1:8790.

Setup (off camera, in order):

```json
[
  {"action":{"type":"sidebar","expr":"ask({cmd:'settings.set',settings:{onboarded:true}})"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'state'}).then(s=>{s=typeof s==='string'?JSON.parse(s):s;return Promise.all(s.tabs.filter(t=>t.url.startsWith('roar://ui/welcome')).map(t=>ask({cmd:'tab.close',id:t.id})))})"}},
  {"action":{"type":"stage","from":"app.html","to":"index.html","stage":1}},
  {"action":{"type":"mcp","name":"initialize","args":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Agent","version":"1.0"}}}}
]
```

Shots:

```json
[
  {"t":0.0,"dur":4.5,"prompt":"Build me a lion tracker called Lion Den. Cinematic, dark, real photos.","action":{"type":"mcp","name":"new_page","args":{"url":"http://127.0.0.1:8790/index.html"}},"caption":"I just **describe** it","lyric":"I'm building a lion tracker. I just describe it."},
  {"t":4.5,"dur":4.5,"action":{"type":"wait"},"caption":"It opens in a **real tab**","zoom":{"el":"#tabs","size":0.45},"lyric":"My agent writes it, and opens it right here."},
  {"t":9.0,"dur":1.0,"prompt":"Make the button play his roar, full screen.","action":{"type":"stage","from":"app.html","to":"index.html","stage":2},"caption":null,"lyric":"Make him roar."},
  {"t":10.0,"dur":3.0,"action":{"type":"mcp","name":"navigate_page","args":{"type":"reload"}},"caption":"It **tests it** itself","lyric":"It tests it itself."},
  {"t":13.0,"dur":1.2,"action":{"type":"wait"},"caption":null,"lyric":"Let him roar."},
  {"t":14.2,"dur":3.8,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"() => { document.getElementById('roar').click(); return 'Clicked Hear him roar: full-screen roar played'; }"},"overlay":true},"caption":null,"lyric":null},
  {"t":18.0,"dur":1.0,"prompt":"Add the pride: four collared lions, live stats.","action":{"type":"stage","from":"app.html","to":"index.html","stage":3},"caption":null,"lyric":"Now add the whole pride."},
  {"t":19.0,"dur":3.0,"action":{"type":"mcp","name":"navigate_page","args":{"type":"reload"}},"caption":null,"lyric":null},
  {"t":22.0,"dur":5.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"() => { roar(); return 'Roar still works on the new scene'; }"}},"caption":"Every change, **live**","lyric":"Every change lands live, in a real tab."},
  {"t":27.0,"dur":1.0,"prompt":"Add a day-to-night slider.","action":{"type":"stage","from":"app.html","to":"index.html","stage":4},"caption":null,"lyric":"And a slider, from day to night."},
  {"t":28.0,"dur":4.0,"action":{"type":"mcp","name":"navigate_page","args":{"type":"reload"}},"caption":null,"lyric":null},
  {"t":32.0,"dur":4.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"() => { slideTo(3, 2600); return 'Dragged the slider to night: Milky Way, 27°C'; }"},"overlay":true},"caption":"It **drags the slider** to check","lyric":"It drags the slider to night, to check it."},
  {"t":36.0,"dur":3.0,"action":{"type":"mcp","name":"ask_user","args":{"question":"Lion Den works: roar, pride roster, live stats, day and night. Ship it?","choices":["Ship it","Keep going"],"timeout_seconds":120},"async":true},"caption":"It **asks** before shipping","zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"Then it asks before shipping."},
  {"t":39.0,"dur":1.0,"action":{"type":"sidebar","click":"[data-alert-choice=\"Ship it\"]"},"caption":null,"zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"Ship it."},
  {"t":40.0,"dur":4.0,"action":{"type":"mcp","name":"notify_user","args":{"level":"done","title":"Lion Den is ready","body":"Roar, pride roster, live stats and a day-to-night slider, tested in your tab."}},"caption":"**Done.** Tested where you can see it","zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"Done. Tested in the tab I'm looking at."},
  {"t":44.0,"dur":2.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"() => { slideTo(85, 1200); setTimeout(roar, 900); return 'ok'; }"}},"caption":null,"lyric":"No screenshots. No copy-paste."},
  {"t":46.0,"dur":5.0,"action":{"type":"wait"},"caption":"Build it with your agent, in your browser. roarbrowser.app","lyric":"Roar. The browser your agent builds in."}
]
```

## Production notes

1. **Staged edits.** The `stage` shots rewrite the served `index.html`. Never caption them as the agent's real output, and don't show a code view.
2. **No brands.** No agent product names in the VO, captions or overlays (`clientInfo.name` is "Agent").
3. **No `url` on `ask_user`**, or the card adds its own Open button.
