// Hero: one day in Roar, in a 768x432 window. The sidebar copies resources/ui/sidebar.html (rows, pinned tiles,
// tab groups, AI sessions, alert cards, footer with space dots); pages are fictional *.example sites.
(function () {
  var box = document.getElementById('hero-roar');
  if (!box) return;
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 768, H = 432;
  box.innerHTML = '<div class="h-clip"><div class="hr"><div class="h-sb"></div><div class="h-pg"><div class="h-view"></div></div>' +
    '<div class="h-cur"><svg viewBox="0 0 18 24" width="18" height="24"><path d="M1.5 1.5v18.2l4.6-4.4 3 6.9 3.1-1.3-3-6.8h6.4z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg></div></div></div><div class="h-label" aria-hidden="true"></div>';
  var win = box.querySelector('.hr'), sb = win.children[0], view = win.querySelector('.h-view'), cur = win.querySelector('.h-cur'), label = box.querySelector('.h-label');
  var scale = 1, focus = [0, 0];
  // Narrow screens zoom in and pan to the part of the window the step is about.
  function fit() {
    var base = box.clientWidth / W, z = box.clientWidth < 440 ? (focus[2] || 1.6) : 1;
    scale = base * z;
    var x = Math.min(Math.max(focus[0], 0), W - W / z), y = Math.min(Math.max(focus[1], 0), H - H / z);
    win.style.transform = 'scale(' + scale + ') translate(' + -x + 'px,' + -y + 'px)';
  }
  new ResizeObserver(fit).observe(box);

  // Favicons: colored tiles with a glyph, like a site's own icon (all fictional).
  var G = {
    mail: '<path d="M2.5 4.5h11v7h-11z" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M2.5 4.8L8 9l5.5-4.2" fill="none" stroke="#fff" stroke-width="1.6"/>',
    cal: '<rect x="2.5" y="3.5" width="11" height="10" rx="2" fill="#fff"/><path d="M2.5 6.8h11" stroke="#0f766e" stroke-width="1.4"/><text x="8" y="12.4" font-size="5.6" font-weight="700" text-anchor="middle" fill="#0f766e" font-family="-apple-system,sans-serif">22</text>',
    chat: '<path d="M3 4.2A1.7 1.7 0 014.7 2.5h6.6A1.7 1.7 0 0113 4.2v4.6a1.7 1.7 0 01-1.7 1.7H7.4L4.5 13v-2.5A1.7 1.7 0 013 8.8z" fill="#fff"/>',
    music: '<path d="M6.2 11.6V4.2l6-1.4v7.6" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="4.7" cy="11.7" r="1.7" fill="#fff"/><circle cx="10.7" cy="10.4" r="1.7" fill="#fff"/>',
    doc: '<path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z" fill="#fff"/><path d="M6.3 8h3.6M6.3 10.2h3.6" stroke="#2563eb" stroke-width="1.1"/>',
    note: '<rect x="3.5" y="2.5" width="9" height="11" rx="1.5" fill="#fff"/><path d="M5.5 6h5M5.5 8.3h5M5.5 10.6h3" stroke="#d97706" stroke-width="1.1"/>',
    pdf: '<text x="8" y="10.6" font-size="5.4" font-weight="800" text-anchor="middle" fill="#fff" font-family="-apple-system,sans-serif">PDF</text>',
    news: '<text x="8" y="12" font-size="10" font-weight="700" text-anchor="middle" fill="#fff" font-family="Georgia,serif">W</text>',
    trail: '<path d="M2.5 12.5l3.8-6 2.4 3.4 1.6-2.2 3.2 4.8z" fill="#fff"/>',
    pan: '<circle cx="7" cy="9" r="3.8" fill="#fff"/><path d="M10.5 9h4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
    home: '<path d="M3 8l5-4.5L13 8v5H3z" fill="#fff"/>',
    room: '<rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M8 3v10" stroke="#fff" stroke-width="1.4"/>'
  };
  function fav(g, c) { return '<span class="h-fav" style="--c:' + c + '"><svg viewBox="0 0 16 16">' + G[g] + '</svg></span>'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  var P = {
    mail: ['mail.example', 'Inbox (3)', 'mail', '#1d4ed8'], cal: ['calendar.example', 'Week of Oct 19', 'cal', '#0f766e'],
    chat: ['chat.example', 'Team chat', 'chat', '#7c3aed'], music: ['music.example', 'Focus mix', 'music', '#db2777'],
    report: ['docs.example', 'Q3 report draft', 'doc', '#2563eb'], standup: ['notes.example', 'Standup notes', 'note', '#d97706'],
    quote: ['files.example', 'Vendor quote.pdf', 'pdf', '#dc2626'], article: ['news.example', 'Why short meetings work', 'news', '#b4532a'],
    notes: ['notes.example', 'Team sync notes', 'note', '#d97706'], trails: ['trails.example', 'Ridge loop trail', 'trail', '#15803d'],
    pasta: ['cook.example', 'Lemon pasta', 'pan', '#ea580c'], flats: ['homes.example', '2-bed flats near the park', 'home', '#4f46e5'],
    rooms: ['rooms.example', 'Book a room', 'room', '#4f46e5']
  };
  var spaces = [
    { name: 'Work', dot: '#ff7a00', tabs: ['report', 'quote'] },
    { name: 'Personal', dot: '#2f9e5b', tabs: ['trails', 'pasta', 'flats'] }
  ];
  var pins = ['mail', 'cal', 'chat', 'music'];

  // Pages
  function bar(k, search) { var p = P[k]; return '<div class="s-bar"><span class="logo" style="--c:' + p[3] + '"><svg viewBox="0 0 16 16">' + G[p[2]] + '</svg></span>' + p[0].split('.')[0][0].toUpperCase() + p[0].split('.')[0].slice(1) + '<span class="srch">' + search + '</span><span class="me">AK</span></div>'; }
  var mails = [[1, 'Priya Natarajan', 'Q3 numbers look good', 'Two small edits on the revenue table before Thursday’s review.', '9:41 AM'],
    [1, 'Facilities', 'Room bookings for next week', 'Rooms 4B and 2A now have screens. Book through the rooms page.', '9:12 AM'],
    [1, 'Sam Okafor', 'Lunch Thursday?', 'The new noodle place on 5th opens at noon. 12:00?', '8:57 AM'],
    [0, 'Jonas Weber', 'Re: vendor quote', 'They can deliver in two weeks if we sign by Friday.', 'Yesterday'],
    [0, 'Payroll', 'Your October payslip is ready', 'Sign in to view and download your payslip.', 'Yesterday'],
    [0, 'Design Weekly', 'Five layouts we liked this week', 'Plus: a short guide to type scales for dashboards.', 'Oct 20'],
    [0, 'Mia, Billing', 'Invoice #2291 paid', 'Thanks, your payment was received. Receipt attached.', 'Oct 20'],
    [0, 'Lena Ortiz', 'Draft for Friday’s newsletter', 'Here’s the piece on short meetings. Comments welcome.', 'Oct 19']];
  var pages = {
    mail: function () { return bar('mail', 'Search mail') + '<div class="m"><nav><span class="new">Compose</span><b class="on">Inbox<em>3</em></b><b>Starred</b><b>Sent</b><b>Drafts<em>1</em></b><b>Archive</b></nav><ul>' +
      mails.map(function (m) { return '<li class="' + (m[0] ? 'u' : '') + '"><i></i><span class="f x">' + m[1] + '</span><span class="x"><span class="s">' + m[2] + '</span>' + m[3] + '</span><time>' + m[4] + '</time></li>'; }).join('') + '</ul></div>'; },
    cal: function () {
      var days = [['Mon', 19], ['Tue', 20], ['Wed', 21], ['Thu', 22], ['Fri', 23]], h = '<div></div>';
      days.forEach(function (d, i) { h += '<div class="d' + (i === 3 ? ' today' : '') + '">' + d[0] + ' <em>' + d[1] + '</em></div>'; });
      for (var r = 0; r < 9; r++) h += '<div class="h" style="grid-row:' + (r + 2) + '">' + ((r + 8) % 12 + 1) + (r < 3 ? ' AM' : ' PM') + '</div><div class="ln" style="grid-row:' + (r + 2) + '"></div>';
      var C = { teal: ['#ccfbf1', '#0f766e'], blue: ['#dbeafe', '#1d4ed8'], amber: ['#fef3c7', '#b45309'], rose: ['#ffe4e6', '#be123c'], violet: ['#ede9fe', '#6d28d9'] };
      [[0, 9, 1, 'Standup', '9:30', 'teal'], [0, 13, 2, 'Design review', 'Room 2A', 'violet'], [1, 9, 1, 'Standup', '9:30', 'teal'], [1, 11, 1, '1:1 with Priya', '', 'blue'], [1, 15, 2, 'Focus time', 'No meetings', 'amber'],
        [2, 9, 1, 'Standup', '9:30', 'teal'], [2, 12, 1, 'Team lunch', '', 'rose'], [2, 14, 1, 'Vendor call', 'Jonas', 'blue'],
        [3, 9, 1, 'Standup', '9:30', 'teal'], [3, 12, 1, 'Lunch with Sam', '5th St', 'rose'], [3, 14, 1, 'Q3 report review', 'Room: not booked', 'violet'],
        [4, 10, 2, 'Sprint planning', 'All hands', 'blue'], [4, 16, 1, 'Demo hour', '', 'amber']].forEach(function (e) {
        var c = C[e[5]]; h += '<div class="e" style="grid-column:' + (e[0] + 2) + ';grid-row:' + (e[1] - 7) + ' / span ' + e[2] + ';--b:' + c[0] + ';--t:' + c[1] + '">' + e[3] + (e[4] ? '<span>' + e[4] + '</span>' : '') + '</div>';
      });
      return bar('cal', 'Search events') + '<div class="c">' + h + '</div>';
    },
    article: function (compact) { return '<div class="n' + (compact ? ' compact' : '') + '"><div class="mast"><small>Work life</small>The Workday</div><div class="body"><div class="kick">Work life</div><h1>Why short meetings work</h1><div class="by"><i></i>By Lena Ortiz, 6 min read</div><div class="img"></div><div class="cap">A written agenda, sent the day before, does most of the work.</div>' +
      '<p>Teams that cap meetings at 25 minutes report clearer decisions and more time for focused work. The trick is not the timer. It is the page of notes everyone reads before they sit down.</p><p>Start with the one decision you need. Anything that does not serve it goes into a message instead.</p></div></div>'; },
    notes: function () { return '<div class="d"><h1>Team sync, Oct 22</h1><div class="meta">notes.example, shared with 6 people</div><h2>Decisions</h2><ul class="chk"><li class="x">Try 25-minute meetings next sprint</li><li class="x">Agenda goes out the day before</li><li>Book a room for the Q3 review</li></ul><h2>Reading</h2><p>Lena’s piece on short meetings, open in the Reading group.</p><h2>Owners</h2><ul><li>Agenda template: Priya</li><li>Room and invite: you</li></ul></div>'; },
    report: function () { return '<div class="d"><h1>Q3 report draft</h1><div class="meta">Edited 4 minutes ago</div><p>Revenue grew in every region this quarter. Support tickets fell by a fifth after the new help pages went live, and the team shipped the pricing page two weeks early.</p>' +
      '<table><tr><th>Region</th><th>Q2</th><th>Q3</th><th>Change</th></tr><tr><td>North</td><td class="num">412k</td><td class="num">468k</td><td class="num up">+14%</td></tr><tr><td>South</td><td class="num">298k</td><td class="num">321k</td><td class="num up">+8%</td></tr><tr><td>West</td><td class="num">351k</td><td class="num">389k</td><td class="num up">+11%</td></tr></table>' +
      '<h2>Next steps</h2><p>Review on Thursday at 2:00 PM. Priya adds the support numbers; Jonas confirms the vendor timeline.</p></div>'; },
    trails: function () { return bar('trails', 'Search trails') + '<div class="t-map"><svg viewBox="0 0 400 170" preserveAspectRatio="none"><path d="M40 140 C 90 90, 120 120, 170 70 S 260 40, 300 80 S 360 120, 330 150" fill="none" stroke="#c2410c" stroke-width="3" stroke-dasharray="7 5"/><circle cx="40" cy="140" r="6" fill="#15803d"/><circle cx="330" cy="150" r="6" fill="#c2410c"/></svg></div>' +
      '<div class="t-list"><div><b>Ridge loop</b><span>6.2 km, moderate, 2 h</span></div><div><b>Lake path</b><span>3 km, easy, dog friendly</span></div><div><b>Pine steps</b><span>4.5 km, steep start</span></div><div><b>Old mill walk</b><span>2 km, stroller friendly</span></div></div>'; },
    rooms: function (st) { return '<div class="r"><h1>Rooms free Thursday, Oct 22</h1><div class="meta">2:00 to 3:00 PM, 3rd and 4th floor</div>' +
      [['4B', 'Room 4B', '6 seats, screen, whiteboard', '#c7d2fe', '#6366f1'], ['2A', 'Room 2A', '4 seats, screen', '#fde68a', '#f59e0b'], ['LB', 'Library', '10 seats, quiet floor', '#bbf7d0', '#10b981']].map(function (r, i) {
        return '<div class="room' + (i === 0 && st ? (st > 1 ? ' pick booked' : ' pick') : '') + '"><div class="ph" style="--a:' + r[3] + ';--b:' + r[4] + '"></div><div><b>' + r[1] + '</b><span>' + r[2] + '</span></div><span class="bk">' + (i === 0 && st > 1 ? 'Booked' : 'Book') + '</span></div>';
      }).join('') + '</div>'; },
    reader: function () { return '<div class="rd"><article><h1>Why short meetings work</h1><p class="src">news.example, Reader mode, ⌥⌘R to leave</p><p>Teams that cap meetings at 25 minutes report clearer decisions and more time for focused work. The trick is not the timer. It is the page of notes everyone reads before they sit down.</p><p>Start with the one decision you need. Anything that does not serve it goes into a message instead.</p><p>The agenda does not need to be long. Three lines will do: what we decide, what we need to know first, and who owns the next step.</p></article></div>'; }
  };

  var S, seen = {};
  function start() { return { space: 0, page: 'mail', split: false, cmd: null, reader: false, toast: false, ai: 0, agent: 0, alert: null, label: '', kbd: '', f: [0, 0] }; }
  function row(k, on, extra) { return '<div class="h-row' + (on ? ' on' : '') + (extra || '') + '" data-k="r' + k + '" data-p="' + k + '">' + fav(P[k][2], P[k][3]) + '<span class="l">' + esc(P[k][1]) + '</span></div>'; }

  function render() {
    var sp = spaces[S.space], h = '';
    h += '<div class="h-top"><span class="h-lights"><i></i><i></i><i></i></span><b><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg></b><b><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg></b><b><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v3h-3"/></svg></b></div>';
    var pg = S.reader ? 'Reader mode' : P[S.page][0];
    h += '<div class="h-addr"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 015 0V7"/></svg><span>' + pg + '</span></div>';
    h += '<div class="h-scroll"><div class="h-pins">' + pins.map(function (k, i) { return '<span class="h-pin' + (S.page === k ? ' on' : '') + '" data-p="' + k + '">' + fav(P[k][2], P[k][3]) + '</span>'; }).join('') + '</div>';
    if (S.space === 0) {
      var a = S.page === 'article' || S.split, n = S.page === 'notes';
      // With sessions or an agent tab showing, the group sits collapsed to make room, as you would in the app.
      var shut = S.ai || S.agent;
      h += '<div><div class="h-gh"><svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" style="transform:rotate(' + (shut ? -90 : 0) + 'deg)"><path d="M1 3h8L5 8z"/></svg><span class="dot" style="--gc:#6a8fd8"></span><span class="gn">Reading</span><span class="n">2</span></div>' + (shut ? '' : '<div class="h-rows g" style="--gc:#6a8fd8">' +
        (S.split ? '<div class="h-pair" data-k="pair">' + row('article', true) + row('notes', false) + '</div>' : row('article', a) + row('notes', n)) + '</div>') + '</div>';
    }
    h += '<div><div class="h-gh"><span>Tabs</span><span class="n">' + (sp.tabs.length + (S.agent ? 1 : 0)) + '</span></div><div class="h-rows">' + sp.tabs.map(function (k) { return row(k, S.page === k); }).join('') +
      (S.agent ? '<div class="h-row on driven" data-k="ragent" data-p="rooms">' + fav('room', '#4f46e5') + '<span class="l">Book a room</span><span class="tag">agent</span></div>' : '') + '</div></div>';
    if (S.ai && S.space === 0 && !S.alert) {
      var rows = [['q3-report', S.ai === 2 ? 'needs' : 'working', S.ai === 2 ? 'Approve: Editing report.md' : S.ai === 3 ? 'Using Roar: new page' : S.ai === 4 ? 'Editing report.md' : 'Reading sales.csv'], ['budget', 'idle', 'Done, waiting for you']];
      h += '<div data-k="ai"><div class="h-gh"><span>AI</span><span class="n">2</span></div><div class="h-rows">' + rows.map(function (r) {
        return '<div class="h-row h-cl' + (r[1] === 'needs' ? ' needs' : '') + '"><span class="dot ' + r[1] + '"></span><span class="l"><span class="nm"><b>' + r[0] + '</b><time>now</time></span><small>' + r[2] + '</small></span></div>';
      }).join('') + '</div></div>';
    }
    h += '</div>';
    if (S.alert) h += '<div class="h-alerts">' + (S.alert === 'ask'
      ? '<div class="h-alert needs" data-k="ask"><div class="who"><span>Agent, q3-report</span><span>now</span></div><span class="x">×</span><div class="t">Book Room 4B for the Q3 review, Thursday 2:00 PM?</div><div class="acts"><b>Book it</b><b>Not yet</b><b>Reply</b></div></div>'
      : '<div class="h-alert done" data-k="done"><div class="who"><span>Agent, q3-report</span><span>now</span></div><span class="x">×</span><div class="t">Booked Room 4B, Thursday 2:00 PM</div><div class="b">Added the room to the review invite.</div></div>') + '</div>';
    h += '<div class="h-foot"><span class="brand"><span class="lion"></span><span class="wm">Roar</span><span class="sn">' + sp.name + '</span></span><span class="h-dots">' + spaces.map(function (s, i) { return '<i class="' + (i === S.space ? 'cur ' : '') + (i === 0 ? 'ag' : '') + '" style="--dot:' + s.dot + '"></i>'; }).join('') + '</span></div>';
    sb.innerHTML = h;
    sb.style.setProperty('--space', sp.dot);

    var v;
    if (S.reader) v = '<div data-k="reader">' + pages.reader() + '</div>';
    else if (S.split) v = '<div class="h-split" data-k="split"><div class="f">' + pages.article(true) + '</div><div>' + pages.notes() + '</div></div>';
    else if (S.page === 'rooms') v = '<div data-k="rooms">' + pages.rooms(S.agent - 1) + '</div>';
    else v = '<div data-k="p' + S.page + '">' + (pages[S.page] ? pages[S.page]() : pages.report()) + '</div>';
    if (S.cmd !== null) {
      var all = [['Reader mode', '⌥⌘R', '<path d="M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5z" fill="none" stroke="currentColor" stroke-width="1.4"/>'], ['Copy page as Markdown', '⇧⌘C', '<path d="M2.5 4.5h11v7h-11z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 9.5v-3l1.5 1.8 1.5-1.8v3M10.5 6.5v3M9.3 8.4l1.2 1.2 1.2-1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>'], ['Split view', '⌘\\', '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 3.5v9" stroke="currentColor" stroke-width="1.4"/>']];
      var q = S.cmd.replace(/^>/, ''), hits = all.filter(function (c) { return c[0].toLowerCase().indexOf(q) >= 0; });
      v += '<div class="h-cmd" data-k="cmd"><div class="q">' + (S.cmd ? esc(S.cmd) + '<i></i>' : '<i></i><span>Search, enter an address, or type &gt; for commands</span>') + '</div>' +
        hits.map(function (c, i) { return '<div class="h-item' + (i === 0 ? ' sel' : '') + '"><svg viewBox="0 0 16 16">' + c[2] + '</svg><span>' + c[0] + '</span><kbd>' + c[1] + '</kbd></div>'; }).join('') + '</div>';
    }
    // Roar's hint pill (Controller::ShowHint, ui/hint.html): bottom center of the page, 24px up.
    if (S.toast) v += '<div class="h-toast" data-k="toast">Copied as Markdown, 83 words</div>';
    view.innerHTML = v;
    label.innerHTML = esc(S.label) + (S.kbd ? '<kbd>' + S.kbd + '</kbd>' : ''); label.style.opacity = S.label ? 1 : 0; label.classList.toggle('up', !!S.toast);
    focus = S.f; fit();
    // Only parts that are new this frame animate in; the rest stays put.
    var now = {};
    [].forEach.call(win.querySelectorAll('[data-k]'), function (el) { now[el.dataset.k] = 1; if (!seen[el.dataset.k]) el.classList.add('pop'); });
    seen = now;
  }

  function el(sel) { return win.querySelector(sel); }
  function aim(sel, dx) {
    var e = el(sel); if (!e) return;
    // Unscaled window coordinates, so a pan in progress doesn't skew the aim.
    var x = 0, y = 0, n = e;
    while (n && n !== win) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    cur.classList.add('on');
    cur.style.transform = 'translate(' + (x + (dx || Math.min(e.offsetWidth / 2, 40))) + 'px,' + (y + e.offsetHeight / 2 - 2) + 'px)';
  }
  function click(sel) { cur.classList.add('down'); var e = el(sel); if (e) e.classList.add('press'); setTimeout(function () { cur.classList.remove('down'); }, 160); }
  function hide() { cur.classList.remove('on'); }

  // Focus [x, y, zoom] in window px for the narrow-screen pan; clamped to the window.
  var SB = [0, 0], SBB = [0, H], PG = [W, 0], MID = [250, 0];
  // [hold ms, state change, optional action after render]
  var steps = [
    [1300, { label: 'Spaces: work and personal', f: SBB }],
    [1000, {}, function () { aim('.h-dots i:nth-child(2)', 8); }],
    [300, {}, function () { click('.h-dots i:nth-child(2)'); }],
    [2000, { space: 1, page: 'trails', f: PG }],
    [900, { f: SBB }, function () { aim('.h-dots i:nth-child(1)', 8); }],
    [300, {}, function () { click('.h-dots i:nth-child(1)'); }],
    [1100, { space: 0, page: 'mail', f: PG }],
    [1000, { label: 'Pinned tabs and tab groups', f: SB }, function () { aim('.h-pin:nth-child(2)'); }],
    [300, {}, function () { click('.h-pin:nth-child(2)'); }],
    [1800, { page: 'cal', f: [0, 0, 1.25] }],
    [1000, { f: SB }, function () { aim('[data-p=article]'); }],
    [300, {}, function () { click('[data-p=article]'); }],
    [1800, { page: 'article', f: [0, 0, 1.25] }, hide],
    [2600, { label: 'Split view', kbd: '⌘\\', split: true, f: [W, 0, 1.15] }],
    [700, { label: 'Command bar', kbd: '⌘T', cmd: '', f: MID }]
  ];
  '>reader'.split('').forEach(function (ch, i, a) { steps.push([i === a.length - 1 ? 1000 : 120, { cmd: a.slice(0, i + 1).join('') }]); });
  steps.push(
    [2400, { label: 'Reader mode', kbd: '⌥⌘R', cmd: null, split: false, reader: true, f: MID }],
    [2200, { label: 'Copy any page as Markdown', kbd: '⇧⌘C', toast: true, f: [250, H] }],
    [1800, { label: 'See what your agents are doing', kbd: '', toast: false, reader: false, page: 'report', ai: 1, f: SBB }],
    [1800, { ai: 2 }],
    [1700, { label: 'Your agent asks before it acts', ai: 3, agent: 2, page: 'rooms', alert: 'ask', f: SBB }],
    [1000, {}, function () { aim('.h-alert .acts b:first-child', 20); }],
    [450, {}, function () { click('.h-alert .acts b:first-child'); }],
    [1000, { ai: 4, alert: 'done' }, hide],
    [2400, { agent: 3, f: [212, 0] }]
  );

  if (reduced) {
    S = start(); Object.assign(S, steps[steps.length - 4][1], { label: 'Your agent asks before it acts', page: 'rooms', ai: 2, agent: 2, alert: 'ask', f: SBB });
    render(); return;
  }
  var i = 0, timer = 0, visible = false;
  function tick() {
    if (i === steps.length) { win.classList.add('fade'); hide(); i = 0; timer = setTimeout(tick, 550); return; }
    if (i === 0) { S = start(); win.classList.remove('fade'); }
    box.dataset.step = i; var s = steps[i++]; Object.assign(S, s[1]); render(); if (s[2]) s[2]();
    timer = setTimeout(tick, s[0]);
  }
  function play() { if (!timer && visible && !document.hidden) tick(); }
  function stop() { clearTimeout(timer); timer = 0; }
  S = start(); render();
  new IntersectionObserver(function (es) { visible = es[0].isIntersecting; visible ? play() : stop(); }).observe(box);
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : play(); });
})();
