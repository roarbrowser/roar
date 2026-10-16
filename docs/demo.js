// Landing page motion: a scripted agent drives a mock Roar window, sections fade in, the hero card cycles.
(function () {
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var stage = document.querySelector('.stage');
  var tabs = stage.querySelector('.tabs'), slot = stage.querySelector('.slot'), url = stage.querySelector('.url');
  var view = stage.querySelector('.view'), log = stage.querySelector('.log'), cursor = stage.querySelector('.cursor');
  var picks = [].slice.call(document.querySelectorAll('.picks button'));
  var run = 0, visible = false, wake = null;

  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

  // Every helper checks the run token so picking another job stops the old one.
  function ctx(t) {
    var c = {};
    c.w = function (ms) { return new Promise(function (ok, no) { setTimeout(function () { t === run ? ok() : no('stop'); }, reduced ? 0 : ms); }); };
    c.reset = function (tab, href) {
      tabs.innerHTML = slot.innerHTML = view.innerHTML = log.innerHTML = '';
      c.tab('Inbox'); c.tab('Docs'); c.tab(tab, true);
      url.textContent = href;
    };
    c.tab = function (name, on) {
      if (on) [].forEach.call(tabs.children, function (x) { x.classList.remove('on'); x.querySelector('small') && x.querySelector('small').remove(); });
      var el = [].filter.call(tabs.children, function (x) { return x.dataset.n === name; })[0] || tabs.appendChild(h('<div class="tab"><b></b>' + name + '</div>'));
      el.dataset.n = name;
      if (on) { el.classList.add('on'); el.insertAdjacentHTML('beforeend', '<small>agent</small>'); }
    };
    c.say = function (s) { log.appendChild(h('<div></div>')).textContent = s; while (log.children.length > 3) log.firstChild.remove(); };
    c.show = function (html) { view.innerHTML = html; return view; };
    c.move = function (el) {
      var r = el.getBoundingClientRect(), s = stage.getBoundingClientRect();
      cursor.style.transform = 'translate(' + (r.left - s.left + Math.min(r.width * .5, 60)) + 'px,' + (r.top - s.top + r.height * .55) + 'px)';
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
    // The visitor can answer; otherwise the cursor answers after a pause.
    c.ask = function (q, choices) {
      c.say('ask_user  "' + q + '"');
      var card = slot.appendChild(h('<div class="card"><div class="who">Your agent asks</div><div class="q"></div><div class="row"></div></div>'));
      card.querySelector('.q').textContent = q;
      var row = card.querySelector('.row');
      return new Promise(function (ok, no) {
        var done = false;
        function pick(i) { if (done || t !== run) return; done = true; c.say('→ "' + choices[i] + '"'); setTimeout(function () { card.remove(); ok(choices[i]); }, 300); }
        choices.forEach(function (label, i) {
          var b = row.appendChild(document.createElement('button')); b.type = 'button'; b.textContent = label;
          b.onclick = function () { pick(i); };
        });
        c.w(3800).then(function () { return done ? 0 : c.move(row.firstChild); })
          .then(function () { return done ? 0 : c.click(row.firstChild); })
          .then(function () { pick(0); }, no);
      });
    };
    c.toast = function (s) { slot.appendChild(h('<div class="toast"></div>')).textContent = s; };
    c.field = function (k, v) { return '<div class="field"><label>' + k + '</label><span>' + (v || '') + '</span></div>'; };
    return c;
  }

  var jobs = [
    async function flight(c) {
      c.reset('Flight search', 'flights.example/search');
      c.say('new_page  flights.example/search');
      var v = c.show('<div>' + c.field('From') + c.field('To') + c.field('Date') + '<span class="go">Search</span></div>');
      var f = v.querySelectorAll('.field'), vals = ['JFK  New York', 'JRO  Kilimanjaro', 'Fri, Nov 14'];
      for (var i = 0; i < 3; i++) {
        await c.move(f[i]); c.say('fill  ' + f[i].firstChild.textContent + '  "' + vals[i] + '"'); await c.type(f[i], vals[i]);
      }
      var go = v.querySelector('.go'); await c.move(go); await c.click(go); c.say('click  Search');
      url.textContent = 'flights.example/results?from=JFK&to=JRO&date=2026-11-14';
      v = c.show('<div></div>').firstChild;
      var fares = [['8:05 AM', '1 stop · 19h 40m', '$386'], ['11:20 AM', '1 stop · 21h 05m', '$412'], ['6:45 PM', '2 stops · 26h 10m', '$398']];
      for (i = 0; i < 3; i++) { v.insertAdjacentHTML('beforeend', '<div class="row2"><span><b>' + fares[i][0] + '</b> <em>' + fares[i][1] + '</em></span><b>' + fares[i][2] + '</b></div>'); await c.w(250); }
      c.say('take_snapshot  → 3 fares, cheapest $386');
      await c.move(v.firstChild); v.firstChild.classList.add('pick'); await c.w(500);
      var a = await c.ask('Book the 8:05 AM flight for $386?', ['Book it', 'Not yet']);
      if (a === 'Book it') {
        c.say('click  Book  →  fill  passenger, seat 14A');
        c.show('<div class="done"><b>Booked ✓</b>JFK → JRO · Fri, Nov 14 · 8:05 AM · seat 14A</div>');
        c.toast('Booked. Confirmation sent to your email.');
      } else { c.say('notify_user  "Holding the fare"'); c.toast('Okay. I’ll watch the fare and ping you if it drops.'); }
      await c.w(3200);
    },
    async function inbox(c) {
      c.reset('Inbox', 'mail.example/inbox');
      c.say('select_page  Inbox');
      var mail = [['Weekly deals', 'Shop', 1], ['Sam Rivera', 'Lunch Thursday?', 0], ['Your receipt', 'Order #4471', 2], ['Newsletter', 'Top 10 this week', 1], ['Dev digest', '42 new posts', 1], ['Priya', 'Contract v2 attached', 0]];
      var v = c.show('<div>' + mail.map(function (m) { return '<div class="row2"><span><b>' + m[0] + '</b> <em>' + m[1] + '</em></span></div>'; }).join('') + '</div>').firstChild;
      c.say('take_snapshot  → 6 unread'); await c.w(700);
      for (var i = 0; i < mail.length; i++) {
        var row = v.children[i];
        if (mail[i][2] === 1) { await c.move(row); await c.click(row); c.say('click  Archive  "' + mail[i][0] + '"'); row.classList.add('gone'); await c.w(350); }
        if (mail[i][2] === 2) { await c.move(row); row.firstChild.insertAdjacentHTML('beforeend', ' <span class="tag">Receipts</span>'); c.say('click  Label  "Receipts"'); await c.w(400); }
      }
      c.say('notify_user  "Inbox 6 → 3"');
      var a = await c.ask('Sam asked about lunch Thursday. Say yes?', ['Reply yes', 'Leave it']);
      if (a === 'Reply yes') {
        c.show('<div>' + c.field('To', 'Sam Rivera') + '<div class="field"><label>Msg</label><span></span></div></div>');
        var f = view.querySelectorAll('.field')[1]; await c.move(f); c.say('type_text  reply');
        await c.type(f, 'Thursday works. 12:30 at the usual place?');
        c.toast('Reply sent to Sam.');
      } else c.toast('Left it for you. Inbox is down to 3.');
      await c.w(3200);
    },
    async function review(c) {
      c.reset('Pull requests', 'git.example/acme/app/pull/212');
      c.say('new_page  git.example/acme/app/pull/212');
      var lines = [['', 'function nextPage(items, i) {'], ['d', '-  while (i < items.length) i++'], ['a', '+  while (i <= items.length) {'], ['a', '+    if (items[i].done) break'], ['a', '+    i++'], ['a', '+  }'], ['', '   return items[i]'], ['', '}']];
      var v = c.show('<div class="diff">' + lines.map(function (l) { return '<div class="' + l[0] + '"></div>'; }).join('') + '</div>').firstChild;
      lines.forEach(function (l, i) { v.children[i].textContent = l[1]; });
      c.say('take_snapshot  → 1 file, +4 −1'); await c.w(600);
      await c.move(v.children[2]); v.children[2].style.boxShadow = 'inset 3px 0 0 var(--mane)'; c.say('evaluate_script  nextPage([], 0)');
      await c.w(500);
      var b = h('<div class="bubble field" style="display:block"><span></span></div>'); v.children[2].after(b);
      await c.type(b, '<= reads past the end: nextPage([], 0) throws. Use < here.');
      var a = await c.ask('Request changes on #212?', ['Send review', 'Edit first']);
      c.toast(a === 'Send review' ? 'Review posted: changes requested.' : 'Draft kept. It’s in the PR for you to edit.');
      await c.w(3200);
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

  // Hero card cycles through the kinds of things an agent asks.
  var q = document.querySelector('.hero .card .q'), tab = document.querySelector('.hero .tab.on');
  var asks = [['Flight search', 'Two fares match. Book the 9:40 nonstop?', 'Book it'], ['Inbox', 'Archive 14 newsletters and keep the 2 from people?', 'Archive'], ['Pull requests', 'Tests pass. Approve and merge #212?', 'Merge'], ['Docs', 'Draft is ready. Share it with the team?', 'Share']];
  var n = 0;
  if (q && !reduced) setInterval(function () {
    var x = asks[++n % asks.length];
    tab.childNodes[1].textContent = x[0]; q.textContent = x[1];
    q.parentNode.querySelector('.yes').textContent = x[2];
    q.parentNode.classList.remove('swap'); void q.offsetWidth; q.parentNode.classList.add('swap');
  }, 4500);
})();
