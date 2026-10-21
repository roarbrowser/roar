# Roar: "Book me a safari" (second video, everyday)

**Output:** `docs/media/roar-safari.mp4` and `roar-safari-web.mp4`. Not on the site until approved.

**Logline:** Someone asks their assistant to book a safari. The assistant opens a travel site in their Roar sidebar and fills in the search, then picks a trip. It asks before spending money, fills in both travellers and asks once more before confirming. Then it reports back with the confirmation.

**Runtime:** 50 s. The voiceover is the assistant talking to the person: warm, brief, first person.

**No brands:** "Lionfold Journeys" is a made-up company on a fictional demo site (`scripts/demo/sites/safari/index.html`, labelled "Demo site · fictional"). Prices, people and the confirmation code are invented, and nothing is booked.

## Film settings

```json
{"output":"roar-safari","serve":"safari","music":{"style":"funk","bpm":92,"key":"D","hits":[11,18,30,34,38,45]},"voice":"Samantha","eleven":"21m00Tcm4TlvDq8ikWAM","poster":35}
```

## Machine shot list

Setup (off camera, in order):

```json
[
  {"action":{"type":"sidebar","expr":"ask({cmd:'settings.set',settings:{onboarded:true}})"}},
  {"action":{"type":"sidebar","expr":"ask({cmd:'state'}).then(s=>{s=typeof s==='string'?JSON.parse(s):s;return Promise.all(s.tabs.filter(t=>t.url.startsWith('roar://ui/welcome')).map(t=>ask({cmd:'tab.close',id:t.id})))})"}},
  {"action":{"type":"mcp","name":"initialize","args":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Assistant","version":"1.0"}}}}
]
```

Shots:

```json
[
  {"t":0.0,"dur":5.0,"prompt":"Book us a 5-day safari in Kenya this September. Two adults, under $4,000.","action":{"type":"mcp","name":"new_page","args":{"url":"http://127.0.0.1:8790/index.html"}},"caption":"**Book me a safari**","lyric":"Sure. Let's find you a safari. I'm opening a travel site, right in your browser."},
  {"t":5.0,"dur":6.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"async () => { await typeInto('#where', 'Kenya'); await typeInto('#when', 'September'); await typeInto('#who', '2'); await typeInto('#budget', '$4,000'); return 'filled'; }"}},"caption":"It fills in the search **in front of you**","lyric":"Kenya. September. Two adults. Under four thousand."},
  {"t":11.0,"dur":4.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"() => search()"},"overlay":true},"caption":null,"lyric":"Three trips fit. Here's what I found."},
  {"t":15.0,"dur":3.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"() => { highlight('mara'); return 'mara'; }"}},"caption":"It **compares** the options","lyric":"This one follows the great migration."},
  {"t":18.0,"dur":4.5,"action":{"type":"mcp","name":"ask_user","args":{"question":"Maasai Mara Explorer: 5 days, $3,480 for two. Book this one?","choices":["Book it","Show others"],"timeout_seconds":120},"async":true},"caption":"It **asks** before spending your money","zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"It's your money, so I'll ask. Thirty-four eighty for two?"},
  {"t":22.5,"dur":1.5,"action":{"type":"sidebar","click":"[data-alert-choice=\"Book it\"]"},"caption":null,"zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"Great."},
  {"t":24.0,"dur":6.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"async () => { choose('mara'); await new Promise(r => setTimeout(r, 600)); await typeInto('#name', 'Alex Rivera', 45); await typeInto('#email', 'alex@example.com', 40); await typeInto('#name2', 'Sam Rivera', 45); return 'details filled'; }"}},"caption":"It fills in **both travellers**","lyric":"I'm filling in your details, for both of you."},
  {"t":30.0,"dur":3.5,"action":{"type":"mcp","name":"ask_user","args":{"question":"Everything looks right. Confirm the booking?","choices":["Confirm","Wait"],"timeout_seconds":120},"async":true},"caption":"One last check","zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"One last check before I confirm."},
  {"t":33.5,"dur":0.5,"action":{"type":"sidebar","click":"[data-alert-choice=\"Confirm\"]"},"caption":null,"lyric":null},
  {"t":34.0,"dur":4.0,"action":{"type":"mcp","name":"evaluate_script","args":{"function":"() => confirmTrip()"}},"caption":null,"lyric":"Done. You're going on safari."},
  {"t":38.0,"dur":5.0,"action":{"type":"mcp","name":"notify_user","args":{"level":"done","title":"Safari booked","body":"Maasai Mara Explorer, September, 2 travellers, $3,480. Confirmation LJ-48217."}},"caption":"**Booked.** The details are in your sidebar","zoom":{"el":"#alerts > .alert:last-child","size":0.42},"lyric":"The confirmation's in your sidebar."},
  {"t":43.0,"dur":2.0,"action":{"type":"wait"},"caption":"Your assistant. Your browser. **You approve.**","lyric":"You just said yes. Twice."},
  {"t":45.0,"dur":5.0,"action":{"type":"wait"},"caption":"Your assistant books it. You stay in charge. roarbrowser.app","lyric":"Roar. Let your assistant do the browsing."}
]
```

## Production notes

1. The site is fictional and says so in its header. Never point this at a real travel site.
2. The `ask_user` cards carry no `url`.
