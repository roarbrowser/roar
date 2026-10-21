# Roar: "Plan the trip, you pay" (everyday cut)

**Output:** `docs/media/roar-everyday.mp4` (16:9, 1920x1080) and `roar-everyday-web.mp4` (1280 wide). Every render is also a take in `docs/media/takes/roar-everyday/` (git-ignored).

**Logline:** Someone asks their AI to plan and help book a Tanzania safari. It opens lodges, flights and game drives as real tabs in a "Trip" space, compares them, asks which lodge, fills each booking form and stops before payment. Their personal space and ghost tabs stay hidden from it, and one click on the sidebar dot locks it out.

**Runtime:** 55.5 s: 50 s of action plus a 5.5 s end card. Spoken first-person voiceover (ElevenLabs "Jordan"), like the hero cut.

**Viewer:** a regular person who wants help with a big trip but would never hand an AI their card. No terminal, no code.

**Mock sites only:** the lodge, flight and safari pages are one local demo page (`scripts/demo/sites/africa-trip/book.html?p=lodges|flights|safari|summary`) served on 127.0.0.1:8790. Brands (Savanna Stays, SkyRoute, Mara Trails), prices and the traveller ("Alex Rivera") are invented. The pay button is disabled and nothing is submitted. No real booking site is opened. The page's `compare()`, `choose()` and `fill()` helpers are called by the agent through MCP `evaluate_script`.

## Shot table

| time | on screen | call | caption | voiceover |
|---|---|---|---|---|
| 0–4 | Prompt bubble; a lodge tab opens in "Trip" | `new_page` lodges | I just **ask** | I'm planning a safari in Tanzania. I just ask my AI. |
| 4–8 | Cards highlight one by one; two marked best rated | `evaluate_script compare()` | It **compares** for me | It opens lodges in my trip space and compares them. |
| 8–11.5 | Card: "Two lodges fit. Which one?" | `ask_user` | It **asks** me to choose | Then it asks me which one. |
| 11.5–13 | Click "Serengeti Tented Camp" | click | | The tented camp. |
| 13–17 | Form appears and types itself; "Stopped before payment" | `evaluate_script choose()+fill()` | It fills it, **stops at payment** | It fills in the booking, and stops before payment. |
| 17–20 | Flights tab opens | `new_page` flights | | Next, flights to Kilimanjaro. |
| 20–24 | Picks the Doha flight and fills it | `evaluate_script` | Flights that **match the dates** | It picks one that matches the lodge dates. |
| 24–27 | Safari tab opens | `new_page` safari | | And a game drive in the Serengeti. |
| 27–30 | Picks the Big Five drive and fills it | `evaluate_script` | | Same thing. Filled in, not paid. |
| 30–34 | Done card: "Trip ready for you" | `notify_user` | **Ready.** I pay when I'm ready | A card says it's ready. I pay when I'm ready. |
| 34–35.5 | Switch to Personal (dot grey) | sidebar | My personal space? **Off limits** | My personal space? |
| 35.5–39 | "What your AI can see" lists only Trip tabs | `list_pages` | | Off limits. It only sees my trip tabs. |
| 39–41.5 | Zoom on Ghost row; list unchanged | `list_pages` | Ghost tabs: **invisible** | Ghost tabs? Invisible to it. |
| 41.5–42.5 | Back to Trip | sidebar | | And when I'm done, |
| 42.5–43.5 | Click the dot; it turns grey | click `#cdp` | One click, **locked out** | one click. |
| 43.5–47 | `new_page` refused, red "blocked" | `new_page` (error) | | Now it can't open a single tab. |
| 47–48 | Click the dot; green | click `#cdp` | One more, and it's **back** | Click again, |
| 48–50 | Trip summary tab opens | `new_page` summary | | and it's back on the trip. |
| 50–55.5 | End card | | Plan it with your AI, in your browser. roarbrowser.app | Roar. Your browser, your AI. You stay in charge. |

## Film settings

```json
{"output":"roar-everyday","serve":"africa-trip","music":{"style":"funk","bpm":104,"key":"A","hits":[8,13,30,42.5,47,50],"prompt":"Warm upbeat modern travel instrumental for a product video voiceover, 104 bpm, bright plucked kalimba and marimba, soft afrobeat-inspired percussion, warm bass, light guitar, optimistic and relaxed, low-mid energy, steady, leaves room for narration, gentle lift near the end, no vocals"},"voice":"Samantha","eleven":"ScZQf6C8aVzMf60NZQVk","poster":15}
```

## Machine shot list

Run by film.mjs: `ROAR_UI_CDP=1 ROAR_CDP_PORT=9343`, a fresh data dir, `--headless=new`, CDP screencast only.

Setup (off camera, in order). Start the MCP session last, after Personal is agents-off and its tabs exist.

```json
[
  {"action":{"type":"sidebar","expr":"ask({cmd:'settings.set',settings:{onboarded:true,claudeSidebar:false}})"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'state'}).then(s=>{s=typeof s==='string'?JSON.parse(s):s;return Promise.all(s.tabs.filter(t=>t.url.startsWith('roar://ui/welcome')).map(t=>ask({cmd:'tab.close',id:t.id})))})"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'space.rename',id:0,name:'Personal'})"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'space.agents',id:0,on:false})"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'run',id:'open:https://en.wikipedia.org/wiki/Serengeti'})"}},
  {"action":{"type":"wait","dur":3}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'state'}).then(s=>{s=typeof s==='string'?JSON.parse(s):s;return s.tabs.find(t=>t.url.includes('wikipedia.org/wiki/Serengeti')).id})","save":"wikiTab"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'run',id:'newGhostTab'})"}},
  {"action":{"type":"sidebar","target":"command","expr":"ask({cmd:'open',text:'https://www.weather.gov',newTab:true})"}},
  {"action":{"type":"wait","dur":3}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'tab.activate',id:$wikiTab})"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'space.add',name:'Trip'}).then(s=>{s=typeof s==='string'?JSON.parse(s):s;return s.spaces.find(x=>x.name==='Trip').id})","save":"trip"}},
  {"action":{"type":"mcp","name":"initialize","args":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Assistant","version":"1.0"}}}},
  {"action":{"type":"mcp","name":"use_profile","args":{"name":"Trip"}}}
]
```

Shots:

```json
[
  {"t":0.0,"dur":4.0,"prompt":"Plan my Tanzania safari in June: a lodge, flights and a game drive. Help me book it, but I'll pay.","action":{"type":"mcp","name":"new_page","args":{"url":"http://127.0.0.1:8790/book.html?p=lodges"}},"caption":"I just **ask**","zoom":{"el":"#tabs","size":0.45},"lyric":"I'm planning a safari in Tanzania. I just ask my AI."},
  {"t":4.0,"dur":4.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"async () => compare()"},"overlay":true},"caption":"It **compares** for me","lyric":"It opens lodges in my trip space and compares them."},
  {"t":8.0,"dur":3.5,"action":{"type":"mcp","name":"ask_user","args":{"question":"Two lodges fit June 12 to 18. Which one?","choices":["Ngorongoro Rim Lodge","Serengeti Tented Camp"],"timeout_seconds":120},"async":true},"caption":"It **asks** me to choose","zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"Then it asks me which one."},
  {"t":11.5,"dur":1.5,"action":{"type":"sidebar","click":"[data-alert-choice=\"Serengeti Tented Camp\"]"},"caption":null,"zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"The tented camp."},
  {"t":13.0,"dur":4.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"async () => { await choose('Serengeti Tented Camp'); return fill({name:'Alex Rivera', dates:'June 12 to 18', guests:'2 adults'}); }"},"overlay":true},"caption":"It fills it, **stops at payment**","lyric":"It fills in the booking, and stops before payment."},
  {"t":17.0,"dur":3.0,"action":{"type":"mcp","name":"new_page","args":{"url":"http://127.0.0.1:8790/book.html?p=flights"}},"caption":null,"lyric":"Next, flights to Kilimanjaro."},
  {"t":20.0,"dur":4.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"async () => { await choose('1 stop via Doha'); return fill({name:'Alex Rivera', dates:'June 11 to 19', guests:'2 adults'}); }"},"overlay":true},"caption":"Flights that **match the dates**","lyric":"It picks one that matches the lodge dates."},
  {"t":24.0,"dur":3.0,"action":{"type":"mcp","name":"new_page","args":{"url":"http://127.0.0.1:8790/book.html?p=safari"}},"caption":null,"lyric":"And a game drive in the Serengeti."},
  {"t":27.0,"dur":3.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"async () => { await choose('Sunrise Big Five drive'); return fill({name:'Alex Rivera', dates:'June 14', guests:'2 adults'}); }"}},"caption":null,"lyric":"Same thing. Filled in, not paid."},
  {"t":30.0,"dur":4.0,"action":{"type":"mcp","name":"notify_user","args":{"level":"done","title":"Trip ready for you","body":"Lodge, flights and a game drive are filled in. Nothing is paid. Review each tab and pay when you're ready."}},"caption":"**Ready.** I pay when I'm ready","zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"A card says it's ready. I pay when I'm ready."},
  {"t":34.0,"dur":1.5,"action":{"type":"sidebar","expr":"ask({cmd:'space.switch',id:0})"},"caption":"My personal space? **Off limits**","lyric":"My personal space?"},
  {"t":35.5,"dur":3.5,"action":{"type":"mcp","name":"list_pages","args":{},"overlay":true},"caption":null,"lyric":"Off limits. It only sees my trip tabs."},
  {"t":39.0,"dur":2.5,"action":{"type":"mcp","name":"list_pages","args":{},"overlay":true},"caption":"Ghost tabs: **invisible**","zoom":{"el":"#ghost-group","size":0.42},"lyric":"Ghost tabs? Invisible to it."},
  {"t":41.5,"dur":1.0,"action":{"type":"sidebar","expr":"ask({cmd:'space.switch',id:$trip})"},"caption":null,"lyric":"And when I'm done,"},
  {"t":42.5,"dur":1.0,"action":{"type":"sidebar","click":"#cdp"},"caption":"One click, **locked out**","zoom":{"el":"#cdp","size":0.4},"lyric":"one click."},
  {"t":43.5,"dur":3.5,"action":{"type":"mcp","name":"new_page","args":{"url":"http://127.0.0.1:8790/book.html?p=summary"},"expectError":true,"overlay":true},"caption":null,"lyric":"Now it can't open a single tab."},
  {"t":47.0,"dur":1.0,"action":{"type":"sidebar","click":"#cdp"},"caption":"One more, and it's **back**","zoom":{"el":"#cdp","size":0.4},"lyric":"Click again,"},
  {"t":48.0,"dur":2.0,"action":{"type":"mcp","name":"new_page","args":{"url":"http://127.0.0.1:8790/book.html?p=summary"}},"caption":null,"lyric":"and it's back on the trip."},
  {"t":50.0,"dur":5.5,"action":{"type":"wait"},"caption":"Plan it with your AI, in your browser. roarbrowser.app","lyric":"Roar. Your browser, your AI. You stay in charge."}
]
```

## Production notes

1. **Never a real booking.** Only the local mock page. Never caption anything as booked or paid. The done card says nothing is paid.
2. **Why the cut-off works.** Personal is already agents-off, so turning Trip off leaves no space open and `new_page` is refused. It doesn't detach a client that's already attached, so the caption says "locked out", never "disconnected".
3. **Panel content** is the take's raw `list_pages` with `roar://ui/*` rows removed. Never typed by hand.
4. **Neutral client name** "Assistant"; `claudeSidebar:false`.
5. **Small print on the end card:** "Demo booking sites with invented prices; nothing was booked or paid. A script stood in for the AI app, sending the calls the prompt implies. Every action in Roar is real."
