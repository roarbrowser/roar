// Landing page motion: a scripted agent (left, its terminal) drives a mock Roar window (right),
// sections fade in, the hero card cycles. Everything shown in Roar matches what Roar really draws.
(function () {
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var stage = document.querySelector('.stage'), out = document.querySelector('.term .out');
  var tabs = stage.querySelector('.tabs'), slot = stage.querySelector('.slot'), url = stage.querySelector('.url');
  var view = stage.querySelector('.view'), cursor = stage.querySelector('.cursor');
  var picks = [].slice.call(document.querySelectorAll('.picks button'));
  var run = 0, visible = false, wake = null;

  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function line(cls) { var d = out.appendChild(document.createElement('div')); d.className = cls; while (out.children.length > 14) out.firstChild.remove(); return d; }

  // Every helper checks the run token so picking another job stops the old one.
  function ctx(t) {
    var c = {};
    c.w = function (ms) { return new Promise(function (ok, no) { setTimeout(function () { t === run ? ok() : no('stop'); }, reduced ? 0 : ms); }); };
    c.reset = function (tab, href) {
      tabs.innerHTML = slot.innerHTML = view.innerHTML = out.innerHTML = '';
      cursor.classList.remove('on');
      c.tab('Inbox'); c.tab('Docs'); c.tab(tab, true);
      url.textContent = href;
    };
    c.tab = function (name, on) {
      if (on) [].forEach.call(tabs.children, function (x) { x.classList.remove('on'); });
      var el = [].filter.call(tabs.children, function (x) { return x.dataset.n === name; })[0] || tabs.appendChild(h('<div class="tab"><b></b></div>'));
      if (!el.dataset.n) { el.dataset.n = name; el.appendChild(document.createTextNode(name)); el.appendChild(document.createElement('i')).textContent = '×'; }
      if (on) el.classList.add('on');
    };
    // Terminal lines: what you typed, the agent's tool calls (Roar's MCP tools), and its replies.
    c.me = function (s) { line('me').textContent = s; return c.w(900); };
    c.ai = function (s) { line('ai').textContent = s; };
    c.say = function (name, args, result) {
      var d = line('tool'); d.appendChild(document.createElement('b')).textContent = 'roar · ' + name;
      d.appendChild(document.createTextNode(args ? ' (' + args + ')' : ''));
      if (result) d.appendChild(document.createElement('small')).textContent = result;
    };
    c.show = function (html) { view.innerHTML = html; return view; };
    c.move = function (el) {
      var r = el.getBoundingClientRect(), s = stage.getBoundingClientRect();
      cursor.classList.add('on');
      cursor.style.transform = 'translate(' + (r.left - s.left + Math.min(r.width * .5, 60)) + 'px,' + (r.top - s.top + r.height * .5) + 'px)';
      return c.w(800);
    };
    c.click = function (el) {
      cursor.classList.remove('click'); void cursor.offsetWidth; cursor.classList.add('click');
      el.classList.add('press'); setTimeout(function () { el.classList.remove('press'); }, 180);
      return c.w(350);
    };
    c.type = function (el, text) {
      el.classList.add('typing'); var span = el.querySelector('span'), i = 0;
      return (function next() {
        if (i > text.length) { el.classList.remove('typing'); return c.w(150); }
        span.textContent = text.slice(0, i++);
        return c.w(45).then(next);
      })();
    };
    // A card at the bottom of Roar's sidebar, like a real notify_user / ask_user alert.
    c.card = function (title, body, done) {
      var card = slot.appendChild(h('<div class="card' + (done ? ' done' : '') + '"><div class="who"><span>Claude Code</span><span>now</span></div><span class="x">×</span><div class="q"></div><div class="b"></div><div class="row"></div></div>'));
      card.querySelector('.q').textContent = title;
      if (body) card.querySelector('.b').textContent = body; else card.querySelector('.b').remove();
      return card;
    };
    // The visitor can answer in the card; otherwise the agent's pointer answers after a pause.
    c.ask = function (q, body, choices) {
      c.say('ask_user', '"' + q + '"', 'waiting for you in Roar…');
      var card = c.card(q, body), row = card.querySelector('.row');
      return new Promise(function (ok, no) {
        var done = false;
        function pick(i) {
          if (done || t !== run) return; done = true;
          out.lastChild.querySelector('small').textContent = 'you chose "' + choices[i] + '"';
          setTimeout(function () { card.remove(); cursor.classList.remove('on'); ok(choices[i]); }, 300);
        }
        choices.forEach(function (label, i) {
          var b = row.appendChild(document.createElement('button')); b.type = 'button'; b.textContent = label;
          b.onclick = function () { pick(i); };
        });
        c.w(4200).then(function () { return done ? 0 : c.move(row.firstChild); })
          .then(function () { return done ? 0 : c.click(row.firstChild); })
          .then(function () { pick(0); }, no);
      });
    };
    c.notify = function (title, body) { c.say('notify_user', '"' + title + '"'); c.card(title, body, true); };
    c.field = function (k, v) { return '<div class="field"><label>' + k + '</label><span>' + (v || '') + '</span></div>'; };
    return c;
  }

  var jobs = [
    async function flight(c) {
      c.reset('Flight search', 'flights.example/search');
      await c.me('Find a flight JFK to Kilimanjaro on Nov 14 under $400. Ask me before booking.');
      c.say('new_page', 'flights.example/search');
      var v = c.show('<div>' + c.field('From') + c.field('To') + c.field('Date') + '<span class="go">Search</span></div>');
      var f = v.querySelectorAll('.field'), vals = ['JFK  New York', 'JRO  Kilimanjaro', 'Fri, Nov 14'];
      for (var i = 0; i < 3; i++) {
        await c.move(f[i]); c.say('fill', f[i].firstChild.textContent + ', "' + vals[i] + '"'); await c.type(f[i], vals[i]);
      }
      var go = v.querySelector('.go'); await c.move(go); await c.click(go); c.say('click', 'Search');
      url.textContent = 'flights.example/results?from=JFK&to=JRO&date=2026-11-14';
      v = c.show('<div></div>').firstChild;
      var fares = [['8:05 AM', '1 stop · 19h 40m', '$386'], ['11:20 AM', '1 stop · 21h 05m', '$412'], ['6:45 PM', '2 stops · 26h 10m', '$398']];
      for (i = 0; i < 3; i++) { v.insertAdjacentHTML('beforeend', '<div class="row2"><span><b>' + fares[i][0] + '</b> <em>' + fares[i][1] + '</em></span><b>' + fares[i][2] + '</b></div>'); await c.w(250); }
      c.say('take_snapshot', '', '3 fares, cheapest $386 at 8:05 AM');
      await c.move(v.firstChild); v.firstChild.classList.add('pick'); await c.w(500);
      var a = await c.ask('Book the 8:05 AM flight for $386?', 'JFK → JRO, one stop, seat 14A.', ['Book it', 'Not yet']);
      if (a === 'Book it') {
        c.say('click', 'Book'); c.say('fill_form', 'passenger, seat 14A');
        c.show('<div class="done"><b>Booked ✓</b>JFK → JRO · Fri, Nov 14 · 8:05 AM · seat 14A</div>');
        await c.w(600); c.notify('Booked. Confirmation sent to your email.', 'Fri Nov 14 · 8:05 AM · $386');
        c.ai('Booked the 8:05 AM for $386. Confirmation is in your email.');
      } else { c.ai('Okay, not booked. The 8:05 AM fare is still open in Roar.'); }
      await c.w(3600);
    },
    async function inbox(c) {
      c.reset('Inbox', 'mail.example/inbox');
      await c.me('Clean up my inbox. Archive the junk and tell me what needs me.');
      c.say('select_page', 'Inbox');
      var mail = [['Weekly deals', 'Shop', 1], ['Sam Rivera', 'Lunch Thursday?', 0], ['Your receipt', 'Order #4471', 2], ['Newsletter', 'Top 10 this week', 1], ['Dev digest', '42 new posts', 1], ['Priya', 'Contract v2 attached', 0]];
      var v = c.show('<div>' + mail.map(function (m) { return '<div class="row2"><span><b>' + m[0] + '</b> <em>' + m[1] + '</em></span></div>'; }).join('') + '</div>').firstChild;
      c.say('take_snapshot', '', '6 unread'); await c.w(700);
      for (var i = 0; i < mail.length; i++) {
        var row = v.children[i];
        if (mail[i][2] === 1) { await c.move(row); await c.click(row); c.say('click', 'Archive "' + mail[i][0] + '"'); row.classList.add('gone'); await c.w(350); }
        if (mail[i][2] === 2) { await c.move(row); row.firstChild.insertAdjacentHTML('beforeend', ' <span class="tag">Receipts</span>'); c.say('click', 'Label "Receipts"'); await c.w(400); }
      }
      var a = await c.ask('Sam asked about lunch Thursday. Say yes?', 'Inbox is down from 6 to 3.', ['Reply yes', 'Leave it']);
      if (a === 'Reply yes') {
        c.show('<div>' + c.field('To', 'Sam Rivera') + '<div class="field"><label>Msg</label><span></span></div></div>');
        var f = view.querySelectorAll('.field')[1]; await c.move(f); c.say('type_text', 'reply to Sam');
        await c.type(f, 'Thursday works. 12:30 at the usual place?');
        c.ai('Archived 3, labelled your receipt, and told Sam yes. Priya’s contract still needs you.');
      } else c.ai('Archived 3 and labelled your receipt. Sam and Priya are waiting on you.');
      await c.w(3600);
    },
    async function review(c) {
      c.reset('Pull requests', 'git.example/acme/app/pull/212');
      await c.me('Review PR 212 and tell me if it’s safe to merge.');
      c.say('new_page', 'git.example/acme/app/pull/212');
      var lines = [['', 'function nextPage(items, i) {'], ['d', '-  while (i < items.length) i++'], ['a', '+  while (i <= items.length) {'], ['a', '+    if (items[i].done) break'], ['a', '+    i++'], ['a', '+  }'], ['', '   return items[i]'], ['', '}']];
      var v = c.show('<div class="diff">' + lines.map(function (l) { return '<div class="' + l[0] + '"></div>'; }).join('') + '</div>').firstChild;
      lines.forEach(function (l, i) { v.children[i].textContent = l[1]; });
      c.say('take_snapshot', '', '1 file, +4 −1'); await c.w(600);
      await c.move(v.children[2]); v.children[2].style.boxShadow = 'inset 3px 0 0 var(--mane)';
      c.say('evaluate_script', 'nextPage([], 0)', 'TypeError: items[i] is undefined');
      await c.w(500);
      var b = h('<div class="bubble field" style="display:block"><span></span></div>'); v.children[2].after(b);
      c.say('type_text', 'review comment');
      await c.type(b, '<= reads past the end: nextPage([], 0) throws. Use < here.');
      var a = await c.ask('Request changes on #212?', 'Off-by-one: the loop reads past the end of the list.', ['Send review', 'Edit first']);
      if (a === 'Send review') { c.say('click', 'Request changes'); c.ai('Not safe yet. I requested changes on the off-by-one.'); }
      else c.ai('Left the comment as a draft for you to edit.');
      await c.w(3600);
    }
  ];

  function until() { return visible ? Promise.resolve() : new Promise(function (ok) { wake = ok; }); }
  async function loop(i) {
    var t = ++run;
    while (true) {
      picks.forEach(function (p, j) { p.setAttribute('aria-pressed', j === i); });
      await until(); if (t !== run) return;
      try { await jobs[i](ctx(t)); } catch (e) { if (e !== 'stop') throw e; return; }
      if (reduced) return;
      i = (i + 1) % jobs.length;
    }
  }
  picks.forEach(function (p, i) { p.onclick = function () { visible = true; loop(i); }; });

  new IntersectionObserver(function (es) {
    visible = es[0].isIntersecting;
    if (visible && wake) { wake(); wake = null; }
  }).observe(stage);
  if (reduced) jobs[0](ctx(++run)).catch(function () {}); else loop(0);

  // Sections rise in as they scroll into view.
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: .12 });
  document.querySelectorAll('main section .wrap').forEach(function (el) { el.classList.add('reveal'); io.observe(el); });

  // Hero: the agent moves between real tabs and asks about each one.
  var card = document.querySelector('.hero .card'), htabs = document.querySelectorAll('.hero .tab');
  var addr = document.querySelector('.hero .addr'), sites = ['mail.example', 'git.example/acme/app/pull/212', 'flights.example', 'docs.example/q4-launch'];
  var asks = [[2, 'Two fares match. Book the 9:40 nonstop?', 'Book it'], [0, 'Archive 14 newsletters and keep the 2 from people?', 'Archive'], [1, 'Tests pass. Approve and merge #212?', 'Merge'], [3, 'The launch plan is drafted. Share it with the team?', 'Share']];
  var n = 0;
  if (card && !reduced) setInterval(function () {
    var x = asks[++n % asks.length];
    [].forEach.call(htabs, function (t, i) { t.classList.toggle('on', i === x[0]); });
    addr.textContent = sites[x[0]]; card.querySelector('.q').textContent = x[1]; card.querySelector('.yes').textContent = x[2];
    card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
  }, 4500);
})();
