/* =====================================================================
   Aura - the page logic.
   Talks to the Python side through window.pywebview.api (see app/app.py).
   Sections: basics, rich text, messages + status line, chats list,
   pictures, sending, modes, composer, dialog, browser pane, window,
   keyboard, terminal (hidden mode), loading screen, front page, start.
   ===================================================================== */

/* ---------- particle loader: vanilla port of Hermes' loader.tsx, type "fourier-flow" ----------
   window.auraLoader(host) draws into host (an element sized by CSS, color = currentColor).
   Returns stop(). The loop also stops by itself once host leaves the page. */
(function () {
  "use strict";
  var TWO_PI = Math.PI * 2, NS = "http://www.w3.org/2000/svg";

  function baseCurve(name, o) {
    return {
      durationMs: o.durationMs, name: name, particleCount: o.particleCount,
      point: o.point || function () { return { x: 50, y: 50 }; },
      pulseDurationMs: o.pulseDurationMs, rotate: o.rotate || false,
      rotationDurationMs: o.rotationDurationMs || 36000,
      strokeWidth: o.strokeWidth, trailSpan: o.trailSpan
    };
  }
  var FOURIER = baseCurve("Fourier Flow", {
    durationMs: 2200, particleCount: 92, pulseDurationMs: 2000, rotationDurationMs: 15000, strokeWidth: 4.2, trailSpan: 0.31
  });
  FOURIER.point = function (progress, detailScale) {
    var t = progress * TWO_PI;
    var mix = 1 + detailScale * 0.16;
    var x = 17 * Math.cos(t) + 7.5 * Math.cos(3 * t + 0.6 * mix) + 3.2 * Math.sin(5 * t - 0.4);
    var y = 15 * Math.sin(t) + 8.2 * Math.sin(2 * t + 0.25) - 4.2 * Math.cos(4 * t - 0.5 * mix);
    return { x: 50 + x, y: 50 + y };
  };

  function buildPath(config, detailScale, steps) {
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var p = config.point(i / steps, detailScale);
      out.push((i === 0 ? "M" : "L") + " " + p.x.toFixed(2) + " " + p.y.toFixed(2));
    }
    return out.join(" ");
  }
  function detailScaleFor(time, config, phaseOffset) {
    var pulseProgress = ((time + phaseOffset * config.pulseDurationMs) % config.pulseDurationMs) / config.pulseDurationMs;
    var pulseAngle = pulseProgress * TWO_PI;
    return 0.52 + ((Math.sin(pulseAngle + 0.55) + 1) / 2) * 0.48;
  }
  function normalizeProgress(progress) { return ((progress % 1) + 1) % 1; }
  function particleFor(config, index, progress, detailScale, strokeScale) {
    var tailOffset = index / (config.particleCount - 1);
    var point = config.point(normalizeProgress(progress - tailOffset * config.trailSpan), detailScale);
    var fade = Math.pow(1 - tailOffset, 0.56);
    return { opacity: 0.04 + fade * 0.96, radius: (0.9 + fade * 2.7) * strokeScale, x: point.x, y: point.y };
  }
  function rotationFor(time, config, phaseOffset) {
    if (!config.rotate) return 0;
    return -(((time + phaseOffset * config.rotationDurationMs) % config.rotationDurationMs) / config.rotationDurationMs) * 360;
  }

  window.auraLoader = function (host, opts) {
    opts = opts || {};
    var config = FOURIER, pathSteps = opts.pathSteps || 240, strokeScale = opts.strokeScale || 1;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true");
    var g = document.createElementNS(NS, "g");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("opacity", "0.1"); path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-width", String(config.strokeWidth * strokeScale));
    g.appendChild(path);
    var dots = [];
    for (var i = 0; i < config.particleCount; i++) {
      var c = document.createElementNS(NS, "circle"); c.setAttribute("fill", "currentColor");
      g.appendChild(c); dots.push(c);
    }
    svg.appendChild(g);
    host.textContent = "";
    host.appendChild(svg);

    var frame = 0, stopped = false, startedAt = performance.now(), phaseOffset = Math.random();
    function render(now) {
      if (stopped) return;
      var time = now - startedAt;
      var progress = ((time + phaseOffset * config.durationMs) % config.durationMs) / config.durationMs;
      var detailScale = detailScaleFor(time, config, phaseOffset);
      g.setAttribute("transform", "rotate(" + rotationFor(time, config, phaseOffset) + " 50 50)");
      path.setAttribute("d", buildPath(config, detailScale, pathSteps));
      for (var k = 0; k < dots.length; k++) {
        var p = particleFor(config, k, progress, detailScale, strokeScale);
        dots[k].setAttribute("cx", p.x.toFixed(2)); dots[k].setAttribute("cy", p.y.toFixed(2));
        dots[k].setAttribute("r", p.radius.toFixed(2)); dots[k].setAttribute("opacity", p.opacity.toFixed(3));
      }
    }
    var still = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      || document.body.classList.contains("calm");
    function loop(now) {
      if (stopped) return;
      if (!host.isConnected) { stopped = true; return; }
      render(now);
      frame = requestAnimationFrame(loop);
    }
    render(performance.now());                     // reduced motion: this one static frame only
    if (!still) frame = requestAnimationFrame(loop);
    return function stop() { stopped = true; cancelAnimationFrame(frame); };
  };
})();

(function () {
  "use strict";

  /* ---------- basics ---------- */
  var api = null, started = false;
  var currentId = null, sessions = [], busy = false, stopFn = null;
  var $ = function (id) { return document.getElementById(id); };
  var messagesEl = $("messages"), input = $("input"), sendBtn = $("sendBtn");
  var noop = function () {};
  var calmMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var MODES = [
    { id: "claude", label: "Aura", tip: "Aura does it all" },
    { id: "auto", label: "Quick", tip: "Fast and free, Aura helps if needed" },
    { id: "qwen", label: "Local", tip: "Runs only on this PC, free" },
    { id: "big", label: "Big project", tip: "Aura plans and builds big things" },
    { id: "polish", label: "Polish", tip: "Aura makes the website of this chat look great" }
  ];
  var mode = "claude";

  function uiLog(m) { try { if (api && api.ui_log) api.ui_log(String(m)); } catch (x) { /* ignore */ } }
  window.addEventListener("error", function (e) { uiLog("JS error: " + e.message + " @" + (e.lineno || "?")); });
  window.addEventListener("unhandledrejection", function (e) { uiLog("promise error: " + (e.reason && (e.reason.message || e.reason))); });

  var toastTimer = 0;
  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3500);
  }

  /* Scrolling: follow new text only while the user is at the bottom. */
  var stick = true;
  messagesEl.addEventListener("scroll", function () {
    stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }, { passive: true });
  function scrollDown(force) {
    if (force || stick) { messagesEl.scrollTop = messagesEl.scrollHeight; stick = true; }
  }

  /* ---------- rich text (markdown-lite; builds DOM nodes, never innerHTML) ---------- */
  function addText(el, s) {
    s.split("\n").forEach(function (part, k) {
      if (k) el.appendChild(document.createElement("br"));
      if (part) el.appendChild(document.createTextNode(part));
    });
  }
  function addInline(el, s) {
    var re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g, last = 0, m, n;
    while ((m = re.exec(s))) {
      addText(el, s.slice(last, m.index));
      if (m[0].charAt(0) === "`") { n = document.createElement("code"); n.textContent = m[0].slice(1, -1); }
      else { n = document.createElement("strong"); n.textContent = m[0].slice(2, -2); }
      el.appendChild(n);
      last = re.lastIndex;
    }
    addText(el, s.slice(last));
  }
  function copyText(s) {
    function fallback() {
      var t = document.createElement("textarea");
      t.value = s; t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); } catch (e) { /* ignore */ }
      t.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s).catch(fallback);
    fallback();
    return Promise.resolve();
  }
  var ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>';
  var ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  /* A copy button: icon (+ optional word), shows a check for 1.5 s after copying. getText() is read at click time. */
  function copyButton(cls, label, word, getText) {
    var btn = document.createElement("button"), t = 0;
    btn.type = "button"; btn.className = cls; btn.title = label;
    btn.setAttribute("aria-label", label);
    function paint(done) {
      btn.innerHTML = done ? ICON_OK : ICON_COPY;
      if (word) btn.appendChild(document.createTextNode(done ? "Copied" : word));
      btn.classList.toggle("done", done);
    }
    paint(false);
    btn.addEventListener("click", function () {
      copyText(getText()).then(function () {
        paint(true); clearTimeout(t);
        t = setTimeout(function () { paint(false); }, 1500);
      });
    });
    return btn;
  }
  function codeBlock(code, lang) {
    var wrap = document.createElement("div"); wrap.className = "code";
    var bar = document.createElement("div"); bar.className = "code-bar";
    var l = document.createElement("span"); l.textContent = lang || "code";
    var btn = copyButton("copy", "Copy code", "Copy", function () { return code; });
    bar.appendChild(l); bar.appendChild(btn);
    var pre = document.createElement("pre"), c = document.createElement("code");
    c.textContent = code;
    pre.appendChild(c);
    wrap.appendChild(bar); wrap.appendChild(pre);
    return wrap;
  }
  function renderRich(el, text) {
    el._raw = String(text || ""); // what the message Copy button copies
    var out = document.createDocumentFragment();
    var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    var i = 0, para = [], list = null, listType = null, m;
    function flushPara() {
      if (!para.length) return;
      var p = document.createElement("p");
      addInline(p, para.join("\n"));
      out.appendChild(p);
      para = [];
    }
    function flushAll() { flushPara(); list = null; listType = null; }
    while (i < lines.length) {
      var line = lines[i];
      if ((m = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line))) {
        flushAll();
        var code = []; i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.appendChild(codeBlock(code.join("\n"), m[1]));
        continue;
      }
      if (/^\s*$/.test(line)) { flushAll(); i++; continue; }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        flushAll();
        var h = document.createElement("h" + (m[1].length + 2));
        addInline(h, m[2]);
        out.appendChild(h);
        i++; continue;
      }
      var ul = /^\s*[-*•]\s+(.*)$/.exec(line), ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var type = ul ? "ul" : "ol";
        if (!list || listType !== type) {
          list = document.createElement(type); listType = type;
          if (ol && ol[1] !== "1") list.start = parseInt(ol[1], 10);
          out.appendChild(list);
        }
        var li = document.createElement("li");
        addInline(li, ul ? ul[1] : ol[2]);
        list.appendChild(li);
        i++; continue;
      }
      list = null; listType = null;
      para.push(line); i++;
    }
    flushPara();
    el.textContent = "";
    el.appendChild(out); // one DOM update per render (cheap while streaming)
  }

  /* ---------- messages ---------- */
  function addBubble(role, text, kind) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + role;
    if (role === "assistant") {
      var badge = document.createElement("div");
      badge.className = "badge";
      badge.textContent = "Aura";
      wrap.appendChild(badge);
    }
    var b = document.createElement("div");
    b.className = "bubble" + (kind ? " " + kind : "");
    if (role === "assistant" && !kind) renderRich(b, text); else { b.textContent = text; b._raw = text; }
    wrap.appendChild(b);
    if (!kind) { // copy button that appears on hover (Hermes style)
      var acts = document.createElement("div"); acts.className = "msg-actions";
      acts.appendChild(copyButton("act", "Copy message", "", function () { return b._raw != null ? b._raw : b.innerText; }));
      wrap.appendChild(acts);
    }
    messagesEl.appendChild(wrap);
    scrollDown(role === "user");
    return b;
  }
  function addChip(text) {
    var c = document.createElement("div");
    c.className = "chip"; c.textContent = text;
    messagesEl.appendChild(c);
  }

  /* Status line like Claude's: animated symbol, shimmering word that fits the phase, live timer. */
  var GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
  var STATUS = {
    think:  { seq: false, words: ["Thinking", "Pondering", "Cogitating", "Ruminating", "Noodling", "Percolating", "Musing", "Mulling it over", "Brewing", "Simmering", "Contemplating", "Deliberating"] },
    look:   { seq: false, words: ["Looking at the picture", "Studying the image", "Taking a close look", "Reading the picture"] },
    read:   { seq: false, words: ["Going through the files", "Taking a look", "Checking the files"] },
    search: { seq: false, words: ["Looking around", "Digging through the files", "Hunting it down"] },
    edit:   { seq: false, words: ["Making changes", "Shaping it", "Writing it out"] },
    work:   { seq: false, words: ["Getting it done", "Handling it", "Taking care of it", "On it"] },
    run:    { seq: false, words: ["Running it", "Executing", "Crunching through it"] },
    build:  { seq: false, words: ["Building", "Testing the pieces", "Putting the pieces together"] },
    web:    { seq: false, words: ["Looking it up", "Checking online"] },
    plan:   { seq: false, words: ["Planning", "Mapping it out", "Splitting the job"] },
    write:  { seq: false, words: ["Writing", "Putting it together", "Shaping the answer", "Wrapping up"] },
    big:    { seq: true,  words: ["Planning", "Splitting the job", "Building the pieces", "Testing the pieces", "Connecting everything", "Checking the result"] },
    polish: { seq: true,  words: ["Reviewing", "Looking for rough edges", "Polishing", "Refining the details", "Final checks"] },
    wait:   { seq: false, words: ["Waiting for the other chat to finish", "Waiting in line"] },
    stop:   { seq: true,  words: ["Stopping"] }
  };
  var CHIP_PREFIX = "";
  var CHIP = { read: "Read files", search: "Searched", edit: "Edited files", run: "Ran a command", work: "Completed a task",
               build: "Built and tested", web: "Looked something up", plan: "Planned the steps" };

  /* Creates the status line at the bottom of the chat. Returns { el, phase(p), stop() }.
     sinceMs: how long the work has already been running (when coming back to a chat that is still working). */
  function startStatus(phase, sinceMs) {
    messagesEl.querySelectorAll(".working").forEach(function (o) { o.remove(); }); // never show two
    var w = document.createElement("div");
    w.className = "working";
    w.setAttribute("role", "status");
    var g = document.createElement("span"); g.className = "st-glyph ld"; g.setAttribute("aria-hidden", "true");
    var stopLoader = window.auraLoader ? window.auraLoader(g) : null;
    if (!stopLoader) g.textContent = GLYPHS[4];
    var v = document.createElement("span"); v.className = "st-verb";
    var m = document.createElement("span"); m.className = "st-meta";
    w.appendChild(g); w.appendChild(v); w.appendChild(m);
    messagesEl.appendChild(w);
    scrollDown();

    var cur = STATUS[phase] ? phase : "think", idx = -1, last = "", t0 = Date.now() - (sinceMs || 0), gi = 4, ticks = 0, nextWord = 0;
    function pick() {
      var list = STATUS[cur] || STATUS.think, word;
      if (list.seq) { idx = Math.min(idx + 1, list.words.length - 1); word = list.words[idx]; }
      else { do { word = list.words[Math.floor(Math.random() * list.words.length)]; } while (word === last && list.words.length > 1); }
      last = word; v.textContent = word + "…";
      nextWord = Date.now() + 3200 + Math.random() * 1200;
    }
    function meta() {
      var s = Math.floor((Date.now() - t0) / 1000);
      var time = s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
      var text = "(" + time + (document.body.classList.contains("can-stop") ? " · esc to interrupt" : "") + ")";
      if (m.textContent !== text) m.textContent = text;
    }
    pick(); meta();
    // One timer drives everything: glyph every 140 ms, timer text and word changes when due.
    var timer = setInterval(function () {
      if (!calmMotion && !stopLoader) { gi = (gi + 1) % GLYPHS.length; g.textContent = GLYPHS[gi]; }
      if (calmMotion || ++ticks % 7 === 0) meta();
      if (Date.now() >= nextWord) pick();
    }, calmMotion ? 1000 : 140);
    return {
      el: w,
      phase: function (p) { if (p === "act") p = "work"; if (p !== cur && STATUS[p]) { cur = p; idx = -1; pick(); } },
      stop: function () { clearInterval(timer); if (stopLoader) stopLoader(); w.remove(); }
    };
  }

  /* ---------- chats work on their own: the page only watches the open one ---------- */
  var running = {}, view = null; // running: chat id -> working; view: the live work shown for the open chat
  function anyRunning() { return Object.keys(running).length > 0; }
  function paintBusy() {
    busy = !!(currentId && running[currentId]);
    var mine = !!(busy && view && view.sid === currentId);
    sendBtn.disabled = busy;
    stopFn = mine ? view.stop : null;
    document.body.classList.toggle("can-stop", mine);
    document.body.classList.toggle("busy", busy);
  }
  function paintRunDots() {
    Array.prototype.forEach.call($("sessionList").querySelectorAll(".session"), function (r) {
      var on = !!running[r.dataset.id];
      r.classList.toggle("working", on);
      r.setAttribute("aria-label", (r.title || "Chat") + (on ? " (Aura is working on it)" : ""));
    });
  }
  function setRunning(sid, on) {
    if (sid && !!running[sid] !== !!on) {
      if (on) running[sid] = true; else delete running[sid];
      paintRunDots();
    }
    paintBusy();
  }
  /* Only for things that must wait for every chat (update, delete all). */
  function guardBusy() {
    if (!anyRunning()) return false;
    toast("Aura is still working on a chat. Wait for it to finish, or press Stop.");
    return true;
  }
  /* Which chats work right now on the Python side: dots in the chat list, and a safety net if the open
     chat's answer finished without the page noticing (it then reloads the chat, which shows the answer). */
  function pollBusy() {
    api.busy_chats().then(function (list) {
      var now = {};
      (list || []).forEach(function (id) { now[id] = true; });
      Object.keys(running).forEach(function (id) { if (!now[id] && !(view && view.sid === id)) delete running[id]; });
      Object.keys(now).forEach(function (id) { running[id] = true; });
      if (view && view.live && !now[view.sid]) { if (++view.lost >= 3) view.resync(); }
      else if (view) view.lost = 0;
      paintRunDots(); paintBusy();
    }).catch(noop).then(function () { setTimeout(pollBusy, 2000); });
  }

  /* ---------- chats list (latest 7, then "Show all") ---------- */
  var RECENT = 7, showAllChats = false;
  function sessionRow(s) {
    var row = document.createElement("div");
    var active = s.id === currentId, title = s.title || "New chat", working = !!running[s.id];
    row.className = "session" + (active ? " active" : "") + (working ? " working" : "");
    row.tabIndex = 0;
    row.dataset.id = s.id;
    row.setAttribute("role", "button");
    if (active) row.setAttribute("aria-current", "true");
    row.title = title;
    row.setAttribute("aria-label", title + (working ? " (Aura is working on it)" : ""));
    var span = document.createElement("span");
    span.textContent = title;
    var dot = document.createElement("i");
    dot.className = "run-dot"; dot.setAttribute("aria-hidden", "true"); dot.title = "Aura is working on this chat";
    var del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "×";
    del.title = "Delete chat";
    del.setAttribute("aria-label", "Delete chat " + title);
    del.addEventListener("click", function (e) { e.stopPropagation(); deleteChat(s); });
    row.appendChild(span);
    row.appendChild(dot);
    row.appendChild(del);
    row.addEventListener("click", function () { if (s.id !== currentId) openSession(s.id); });
    row.addEventListener("keydown", function (e) {
      if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
    });
    return row;
  }
  function renderSessions() {
    var list = $("sessionList"), frag = document.createDocumentFragment();
    var lbl = document.querySelector(".side-label");
    // remember which chat row had keyboard focus, so a refresh does not throw the focus away
    var fa = document.activeElement, focusId = null;
    if (fa && list.contains(fa) && fa.closest(".session")) focusId = fa.closest(".session").dataset.id;
    if (lbl) lbl.textContent = sessions.length ? "Chats · " + sessions.length : "Chats";
    if (!sessions.length) {
      var e = document.createElement("div");
      e.className = "empty"; e.textContent = "No chats yet";
      frag.appendChild(e);
    } else {
      var visible = showAllChats ? sessions : sessions.slice(0, RECENT);
      if (!showAllChats) { // keep the open chat visible even if it is an older one
        for (var k = RECENT; k < sessions.length; k++) if (sessions[k].id === currentId) { visible = visible.concat([sessions[k]]); break; }
      }
      visible.forEach(function (s) { frag.appendChild(sessionRow(s)); });
      if (sessions.length > RECENT) frag.appendChild(moreButton(list));
    }
    list.textContent = "";
    list.appendChild(frag);
    if (focusId) {
      var again = Array.prototype.filter.call(list.querySelectorAll(".session"), function (r) { return r.dataset.id === focusId; })[0];
      if (again) again.focus();
    }
  }
  function moreButton(list) {
    var more = document.createElement("button"), older = sessions.length - RECENT;
    more.type = "button"; more.className = "more-chats";
    more.setAttribute("aria-expanded", showAllChats ? "true" : "false");
    more.title = showAllChats ? "Show only the latest chats" : older + " older chat" + (older === 1 ? "" : "s");
    var label = document.createElement("span");
    label.textContent = showAllChats ? "Show less" : "Show all (" + sessions.length + ")";
    more.appendChild(label);
    more.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'
      + (showAllChats ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6") + '"/></svg>');
    more.addEventListener("click", function () {
      var hadFocus = document.activeElement === more; // the chat filter also clicks this: never steal its focus
      showAllChats = !showAllChats; renderSessions();
      if (!showAllChats) list.scrollTop = 0;
      var again = list.querySelector(".more-chats"); if (again && hadFocus) again.focus();
    });
    return more;
  }
  function deleteChat(s) {
    var text = "“" + (s.title || "New chat") + "” and all its messages will be removed. This can’t be undone.";
    if (running[s.id]) text = "Aura is still working on this chat; that work stops. " + text;
    askConfirm({ title: "Delete this chat?", text: text, ok: "Delete", danger: true }).then(function (yes) {
      if (!yes) return;
      if (view && view.sid === s.id) view.detach();
      return api.delete_session(s.id).then(function (ok) {
        if (!ok) toast("Could not delete this chat.");
        else {
          setRunning(s.id, false);
          if (currentId === s.id) { currentId = null; messagesEl.textContent = ""; }
        }
        return refreshSessions();
      }).then(function () {
        if (!currentId) return sessions.length ? openSession(sessions[0].id) : newChat();
      });
    }).catch(function () { toast("Could not delete this chat."); });
  }
  function refreshSessions() {
    return api.list_sessions().then(function (list) {
      sessions = list || [];
      renderSessions();
    }).catch(function () { toast("Could not load your chats."); });
  }
  /* A saved message. The internal [Who] tag is dropped; [App] = an error Aura showed, [Note] = "Stopped." */
  function showStored(m) {
    var raw = m.text || "";
    if (m.role === "user") { addBubble("user", raw); return; }
    var tag = (/^\[([A-Za-z]+)\]\s?/.exec(raw) || [])[1];
    addBubble("assistant", raw.replace(/^\[[A-Za-z]+\]\s?/, ""), tag === "App" ? "error" : tag === "Note" ? "note" : null);
  }
  /* Open a chat. If it is still working (maybe started before you switched away), its live state comes back:
     text so far, step lines and the running timer. The work of the chat you leave keeps going. */
  function openSession(id) {
    if (view) view.detach();
    currentId = id;
    messagesEl.textContent = "";
    messagesEl.classList.add("loading"); // no front-page flash while the chat loads
    stick = true;
    renderSessions(); paintBusy();
    return api.open_chat(id).then(function (data) {
      if (currentId !== id) return;
      if (!data || data.error) { addBubble("assistant", "This chat could not be opened.", "error"); return; }
      (data.messages || []).forEach(showStored);
      if (data.run) attachRun(id, data.run).start(); else setRunning(id, false);
      scrollDown(true);
    }).catch(function () {
      if (currentId === id) addBubble("assistant", "This chat could not be opened.", "error");
    }).then(function () { if (currentId === id) messagesEl.classList.remove("loading"); }); // an older, slower load must not end a newer one
  }
  function newChat() {
    return api.new_session().then(function (id) {
      if (!id) throw new Error("no id");
      if (view) view.detach();
      currentId = id;
      messagesEl.textContent = "";
      messagesEl.classList.remove("loading");
      stick = true;
      paintBusy();
      return refreshSessions();
    }).catch(function () { toast("Could not start a new chat. Please try again."); });
  }

  /* ---------- pictures: attach, paste, drag and drop ---------- */
  var pics = [], docs = [], MAX_PIC = 8 * 1024 * 1024, MAX_DOC = 25 * 1024 * 1024;
  function focusInput() { input.focus(); }
  function focusInputSoon() { setTimeout(focusInput, 0); setTimeout(focusInput, 150); }
  function picUrl(p) { return "data:" + p.media_type + ";base64," + p.data; }
  function renderThumbs() {
    var el = $("thumbs"); el.textContent = "";
    pics.forEach(function (p, i) {
      var d = document.createElement("div"); d.className = "th";
      var im = document.createElement("img"); im.src = picUrl(p); im.alt = "Picture " + (i + 1);
      var x = document.createElement("button"); x.type = "button"; x.textContent = "×";
      x.title = "Remove picture";
      x.setAttribute("aria-label", "Remove picture " + (i + 1));
      x.addEventListener("click", function () { pics.splice(i, 1); renderThumbs(); focusInput(); });
      d.appendChild(im); d.appendChild(x); el.appendChild(d);
    });
    docs.forEach(function (f, i) {
      var d = document.createElement("div"); d.className = "th doc";
      var n = document.createElement("span"); n.textContent = f.name; n.title = f.path;
      var x = document.createElement("button"); x.type = "button"; x.textContent = "\u00d7";
      x.title = "Remove file"; x.setAttribute("aria-label", "Remove file " + f.name);
      x.addEventListener("click", function () { docs.splice(i, 1); renderThumbs(); focusInput(); });
      d.appendChild(n); d.appendChild(x); el.appendChild(d);
    });
  }
  /* Any other file (text, code, PDF, zip...): remember where it is; the assistant reads it from that path. */
  function addDoc(f) {
    if (f.size > MAX_DOC) { toast("That file is too big (max 25 MB)."); return; }
    function keep(p) { docs.push({ name: f.name, path: p }); renderThumbs(); focusInput(); }
    if (f.pywebviewFullPath) { keep(f.pywebviewFullPath); return; }
    if (!api) { toast("One moment, still loading."); return; }
    var r = new FileReader();
    r.onload = function () {
      var s = String(r.result);
      api.save_dropped(f.name, s.slice(s.indexOf(",") + 1)).then(function (res) {
        if (res && res.path) keep(res.path); else toast("Could not add that file.");
      }).catch(function () { toast("Could not add that file."); });
    };
    r.onerror = function () { toast("Could not read that file."); };
    r.readAsDataURL(f);
  }
  function addFiles(files) {
    Array.prototype.forEach.call(files, function (f) {
      if (!f.type || f.type.indexOf("image/") !== 0) { addDoc(f); return; }
      if (f.size > MAX_PIC) { toast("That picture is too big (max 8 MB)."); return; }
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result);
        pics.push({ media_type: f.type, data: s.slice(s.indexOf(",") + 1) });
        renderThumbs();
        focusInput();
      };
      r.onerror = function () { toast("Could not read that picture."); };
      r.readAsDataURL(f);
    });
  }
  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, "Files") !== -1;
  }

  /* ---------- sending ---------- */
  /* While Aura works, look for a website it creates or changes (only while busy, no overlapping calls). */
  function watchSites(since) {
    var timer = setInterval(function () { checkSite(since); }, 4000);
    return function () { clearInterval(timer); checkSite(since); };
  }

  /* The live work of the open chat: status line with timer, streamed text (Aura mode), step lines
     ("Reading notes.pdf", "Saving index.html"...), then the answer. run = { kind: "aura"|"job", phase,
     elapsed (s), items (what already happened, when coming back to the chat) }. Returns a view:
     start() begins polling, stop() asks Python to stop, detach() only stops watching (the work goes on),
     fail(msg) shows a start error, resync() reloads the chat from what Python saved. */
  function attachRun(sid, run) {
    if (view) view.detach();
    var kind = run.kind === "aura" ? "aura" : "job", finished = false, timer = 0, delay = 80;
    var cur = null, pending = null, raf = 0, stopAsked = 0, elapsed = Math.max(0, +run.elapsed || 0);
    var st = startStatus(run.phase || "think", elapsed * 1000);
    var stopWatch = watchSites(Date.now() / 1000 - 1 - elapsed);
    var v = { sid: sid, kind: kind, live: false, lost: 0 };
    function flush() {
      raf = 0;
      if (pending) { renderRich(pending.el, pending.text); scrollDown(); }
      pending = null;
    }
    function keepStatusLast() { messagesEl.appendChild(st.el); scrollDown(); }
    function newBubble() { cur = addBubble("assistant", ""); keepStatusLast(); }
    function chip(it) { addChip(CHIP_PREFIX + (it.text || CHIP[it.kind] || "Completed a task")); cur = null; }
    function close(keepRunning) {
      if (finished) return false;
      finished = true; v.live = false;
      clearTimeout(timer);
      if (raf) { cancelAnimationFrame(raf); flush(); }
      st.stop(); stopWatch();
      if (view === v) view = null;
      if (keepRunning) paintBusy(); else setRunning(sid, false);
      return true;
    }
    function finish(e) {
      if (finished) return;
      if (raf) { cancelAnimationFrame(raf); flush(); } // draw the last text first
      if (cur && !cur.textContent.trim() && cur.parentNode) cur.parentNode.remove(); // never leave an empty bubble
      close(false);
      if (e.t === "closed") addBubble("assistant", "Aura stopped unexpectedly. Please send your message again.", "error");
      else if (e.note) addBubble("assistant", e.text || "Stopped.", "note");
      else if (e.error) addBubble("assistant", e.text || "Something went wrong. Please try again.", "error");
      else if (kind === "job") addBubble("assistant", e.text || "No answer.");
      refreshSessions();
      if (!document.querySelector(".modal-back") && !termVisible()) focusInput();
    }
    function handle(e) {
      if (e.t === "new_bubble") newBubble();
      else if (e.t === "text") {
        st.phase("write");
        if (!cur) newBubble();
        pending = { el: cur, text: e.text || "" };
        if (!raf) raf = requestAnimationFrame(flush);
      } else if (e.t === "tool" || e.t === "step") { chip(e); st.phase(e.kind || "work"); keepStatusLast(); }
      else if (e.t === "phase") { if (!stopAsked) st.phase(e.kind || "think"); }
      else if (e.t === "done" || e.t === "closed") { finish(e); return true; }
      return false;
    }
    function poll() {
      if (finished) return;
      (kind === "aura" ? api.chat_poll(sid) : api.job_poll(sid)).then(function (lines) {
        if (finished) return;
        lines = lines || [];
        for (var k = 0; k < lines.length; k++) {
          var e; try { e = JSON.parse(lines[k]); } catch (x) { continue; }
          if (handle(e)) return;
        }
        if (stopAsked && Date.now() - stopAsked > 6000) { finish({ t: "done", note: true, text: "Stopped." }); return; }
        delay = lines.length ? 80 : Math.min(delay + 40, 400); // fast while text flows, calmer while waiting
        timer = setTimeout(poll, delay);
      }).catch(function () { if (!finished) timer = setTimeout(poll, 600); });
    }
    (run.items || []).forEach(function (it) { if (it.k === "text") cur = addBubble("assistant", it.text || ""); else chip(it); });
    keepStatusLast();
    v.start = function () { if (!finished && !v.live) { v.live = true; poll(); } return v; };
    v.stopped = function () { return !!stopAsked; };
    v.fail = function (msg) {
      if (close(false)) { addBubble("assistant", msg || "Aura could not start. Please try again.", "error"); refreshSessions(); }
    };
    v.detach = function () { close(true); };
    v.stop = function () {
      if (finished || stopAsked) return;
      stopAsked = Date.now();
      st.phase("stop");
      api.chat_stop(sid).catch(noop);
      v.start(); // keep listening: Python answers with "Stopped." (or the reply, if it was just finishing)
    };
    v.resync = function () {
      if (!close(true)) return;
      delete running[sid];
      if (currentId === sid) openSession(sid);
    };
    view = v;
    setRunning(sid, true);
    return v;
  }

  function send() {
    var text = input.value.trim();
    if ((!text && !pics.length && !docs.length) || busy) return;
    if (!api || !currentId) { toast("One moment, the chat is still loading."); return; }
    var images = pics.slice(), files = docs.slice(), shown = text;
    if (images.length && (mode === "big" || mode === "polish")) { toast("Pictures work in Aura, Quick and Local modes."); return; }
    pics = []; docs = []; renderThumbs();
    input.value = "";
    input.dispatchEvent(new Event("input")); // re-sizes the box and resets the send button colour
    if (files.length) {
      shown = (shown + "\nAttached: " + files.map(function (f) { return f.name; }).join(", ")).trim();
      text = (text + "\n\n[Attached files. Read them from these paths:\n" + files.map(function (f) { return f.path; }).join("\n") + "]").trim();
    }
    var ub = addBubble("user", shown);
    images.forEach(function (p) {
      var im = document.createElement("img"); im.src = picUrl(p); im.alt = "Sent picture";
      ub.insertBefore(im, ub.firstChild);
    });
    startWork(currentId, mode, text, images);
  }
  /* Aura mode streams from the chat's own background process; the other modes run as a background job.
     Either way the answer is saved into THIS chat, even if you switch to another one meanwhile. */
  function startWork(sid, m, text, images) {
    var v = attachRun(sid, { kind: m === "claude" ? "aura" : "job", elapsed: 0, items: [],
                             phase: m === "big" ? "big" : m === "polish" ? "polish" : (images.length ? "look" : "think") });
    var imgs = images.length ? images : null;
    (m === "claude" ? api.chat_send(sid, text, imgs) : api.job_start(sid, text, m, imgs)).then(function (r) {
      if (!r || !r.ok) { v.fail((r && r.error) || "Aura could not start. Please try again."); return; }
      if (v.stopped()) api.chat_stop(sid).catch(noop); // Stop was pressed while it was starting
      v.start();
    }).catch(function () { v.fail("Aura could not start. Please try again."); });
  }


  /* ---------- modes ---------- */
  function buildPills() {
    var wrap = $("pills");
    MODES.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pill" + (m.id === mode ? " active" : "");
      b.textContent = m.label;
      b.title = m.tip;
      b.dataset.id = m.id;
      b.setAttribute("aria-pressed", m.id === mode ? "true" : "false");
      b.addEventListener("click", function () { setMode(m); });
      wrap.appendChild(b);
    });
    $("pillHint").textContent = MODES[0].tip;
  }
  function setMode(m) {
    mode = m.id;
    Array.prototype.forEach.call($("pills").children, function (c) {
      var on = c.dataset.id === mode;
      c.classList.toggle("active", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("pillHint").textContent = m.tip;
  }

  /* ---------- composer ---------- */
  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  /* ---------- confirm dialog ---------- */
  function askConfirm(o) {
    return new Promise(function (resolve) {
      ovSuspend();
      var prev = document.activeElement, closed = false;
      var back = document.createElement("div"); back.className = "modal-back";
      var card = document.createElement("div"); card.className = "modal" + (o.danger ? " danger" : "");
      card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-labelledby", "mTitle"); card.setAttribute("aria-describedby", "mText");
      var ico = document.createElement("div"); ico.className = "modal-ico"; ico.setAttribute("aria-hidden", "true");
      ico.innerHTML = o.danger
        ? '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
      var h = document.createElement("h3"); h.id = "mTitle"; h.textContent = o.title;
      var p = document.createElement("p"); p.id = "mText"; p.textContent = o.text;
      var row = document.createElement("div"); row.className = "modal-btns";
      var no = document.createElement("button"); no.type = "button"; no.className = "m-no"; no.textContent = o.cancel || "Cancel";
      var yes = document.createElement("button"); yes.type = "button"; yes.className = "m-yes"; yes.textContent = o.ok || "OK";
      row.appendChild(no); row.appendChild(yes);
      card.appendChild(ico); card.appendChild(h); card.appendChild(p); card.appendChild(row);
      back.appendChild(card); document.body.appendChild(back);
      requestAnimationFrame(function () { back.classList.add("show"); });
      function close(v) {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey, true);
        back.classList.remove("show");
        setTimeout(function () {
          back.remove();
          ovResume();
          if (prev && prev.focus && document.contains(prev)) { try { prev.focus(); } catch (e) { /* ignore */ } } else focusInput();
        }, 180);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === "Tab") { e.preventDefault(); (document.activeElement === no ? yes : no).focus(); }
      }
      document.addEventListener("keydown", onKey, true);
      no.addEventListener("click", function () { close(false); });
      yes.addEventListener("click", function () { close(true); });
      back.addEventListener("mousedown", function (e) { if (e.target === back) close(false); });
      (o.danger ? no : yes).focus();
    });
  }

  /* ---------- browser pane (right side): websites Aura builds + normal browsing ---------- */
  var HOME = "https://www.bing.com/";
  var lastSite = null, hist = [], hpos = -1, curUrl = "", navSeq = 0;
  var pane = $("preview"), frame = $("pvFrame"), host = $("pvOverlayHost");

  function isLocalUrl(u) { return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(u); }
  function cleanUrl(u) { return u.replace(/[?&]t=\d+$/, ""); }
  function embedUrl(u) {
    var m = u.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([\w-]{6,20})/i)
         || u.match(/^https?:\/\/youtu\.be\/([\w-]{6,20})/i)
         || u.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:shorts|live)\/([\w-]{6,20})/i);
    return m ? "https://www.youtube.com/embed/" + m[1] + "?autoplay=1" : u;
  }
  function paneOpen() { return pane.classList.contains("open"); }
  function setPaneOpen(on) {
    pane.classList.toggle("open", on);
    $("pvTab").hidden = on;
    var tg = $("paneToggle");
    tg.classList.toggle("on", on);
    tg.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function updNav() { $("pvBack").disabled = hpos <= 0; $("pvFwd").disabled = hpos >= hist.length - 1; }

  var loadingTimer = 0;
  function setLoading(on) {
    pane.classList.toggle("loading", on);
    clearTimeout(loadingTimer);
    if (on) loadingTimer = setTimeout(function () { pane.classList.remove("loading"); }, 15000);
  }
  frame.addEventListener("load", function () { if (frame.getAttribute("src") !== "about:blank") setLoading(false); });

  function loadInFrame(u) {
    ovHide();
    $("pvBlocked").hidden = true; $("pvStart").hidden = true; frame.hidden = false;
    setLoading(true);
    frame.src = "about:blank"; // forces a real reload, even for the same address
    setTimeout(function () { frame.src = u; }, 30);
  }

  /* Sites that refuse a normal frame (YouTube, Google...) get a real browser view fastened exactly over the pane. */
  var ovOn = false, ovSuspended = false, ovTimer = 0;
  function ovRect() {
    var r = host.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    return [r.left * d, r.top * d, r.width * d, r.height * d].map(Math.round);
  }
  function ovSync() {
    if (!ovOn || ovSuspended || !api) return;
    var r = ovRect();
    api.overlay_move(r[0], r[1], r[2], r[3]).catch(noop);
  }
  function ovStartWatch() { if (!ovTimer) ovTimer = setInterval(ovSync, 500); } // only while the view is shown
  function ovHide() {
    if (ovOn && api) api.overlay_hide(true).catch(noop);
    ovOn = false; host.hidden = true;
    clearInterval(ovTimer); ovTimer = 0;
  }
  function ovSuspend() { ovSuspended = true; if (ovOn && api) api.overlay_hide().catch(noop); }
  function ovResume() { ovSuspended = false; ovSync(); }
  window.addEventListener("resize", ovSync);
  if (window.ResizeObserver) new ResizeObserver(ovSync).observe(host);

  function showBlockedCard(u) {
    ovHide();
    setLoading(false);
    $("pvStart").hidden = true; frame.hidden = true; $("pvBlocked").hidden = false;
    $("pvBlockedUrl").textContent = u;
  }
  function showOverlay(u, seq) {
    $("pvStart").hidden = true; frame.hidden = true; $("pvBlocked").hidden = true;
    if (!api) { showBlockedCard(u); return; }
    host.hidden = false;
    setLoading(true);
    setTimeout(function () { // wait for the pane to finish sliding in
      if (seq !== navSeq || !paneOpen()) return;
      var r = ovRect();
      api.overlay_open(u, r[0], r[1], r[2], r[3]).then(function (res) {
        var ok = !!(res && res.ok);
        if (seq !== navSeq || !paneOpen()) { if (ok && !ovOn) api.overlay_hide(true).catch(noop); return; }
        setLoading(false);
        if (!ok) { showBlockedCard(u); return; }
        ovOn = true; ovStartWatch();
        if (ovSuspended) api.overlay_hide().catch(noop); else ovSync();
      }).catch(function () { if (seq === navSeq) showBlockedCard(u); });
    }, 320);
  }

  function unwrapBing(u) { // Bing result links are redirect wrappers; use the real address
    try {
      if (!/^https?:\/\/(?:www\.)?bing\.com\/ck\/a\?/i.test(u)) return u;
      var p = new URL(u).searchParams.get("u");
      if (p && p.indexOf("a1") === 0) {
        var s = atob(p.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
        if (/^https?:\/\//i.test(s)) return s;
      }
    } catch (e) { /* keep the original address */ }
    return u;
  }
  function navigate(u, push) {
    u = unwrapBing(u);
    var seq = ++navSeq;
    setPaneOpen(true); curUrl = u;
    if (push !== false) { hist = hist.slice(0, hpos + 1); hist.push(u); hpos = hist.length - 1; }
    updNav();
    $("pvAddr").value = cleanUrl(u);
    var target = embedUrl(u);
    if (isLocalUrl(u) || !api) { loadInFrame(target); return; }
    setLoading(true);
    api.frame_check(target).then(function (r) {
      if (seq !== navSeq) return; // the user went somewhere else meanwhile
      if (r && r.embeddable === false) showOverlay(u, seq); else loadInFrame(target);
    }).catch(function () { if (seq === navSeq) loadInFrame(target); });
  }
  function goText(t) {
    if (!t || !t.trim()) return;
    if (!api) { toast("One moment, still loading."); return; }
    api.normalize_url(t).then(function (u) { if (u) navigate(u); else toast("That address doesn't look right."); }).catch(noop);
  }
  function showSite(r, force) {
    if (!force && lastSite && lastSite.path === r.path && lastSite.mtime === r.mtime && paneOpen()) return;
    var same = lastSite && lastSite.path === r.path;
    lastSite = r;
    if (currentId && api && r.path) api.remember_site(currentId, r.path).catch(noop);
    navigate(r.url + "?t=" + Date.now(), !same);
  }
  var siteCheckBusy = false, siteCheckAgain = null; // one check at a time; a request meanwhile runs right after
  function checkSite(since) {
    if (!api) return;
    if (siteCheckBusy) { siteCheckAgain = since; return; }
    siteCheckBusy = true;
    api.site_check(since).then(function (r) { if (r && r.found) showSite(r); }).catch(noop)
      .then(function () {
        siteCheckBusy = false;
        if (siteCheckAgain !== null) { var next = siteCheckAgain; siteCheckAgain = null; checkSite(next); }
      });
  }
  function newestSite() {
    if (!api) { toast("One moment, still loading."); return; }
    api.site_check(Date.now() / 1000 - 86400).then(function (r) {
      if (r && r.found) showSite(r, true); else toast("No website found yet. Ask Aura to build one.");
    }).catch(function () { toast("Could not look for a website."); });
  }
  function showingSite() { return lastSite && curUrl.indexOf(lastSite.url) === 0; }
  function openBrowser() {
    if (showingSite()) { showSite(lastSite, true); return; }
    if (curUrl) { navigate(curUrl, false); return; }
    setPaneOpen(true); setTimeout(function () { $("pvAddr").focus(); }, 60);
  }
  function closeBrowser() { navSeq++; ovHide(); setLoading(false); setPaneOpen(false); }

  $("pvBack").addEventListener("click", function () { if (hpos > 0) { hpos--; navigate(hist[hpos], false); } });
  $("pvFwd").addEventListener("click", function () { if (hpos < hist.length - 1) { hpos++; navigate(hist[hpos], false); } });
  $("pvReload").addEventListener("click", function () { if (showingSite()) showSite(lastSite, true); else if (curUrl) navigate(curUrl, false); });
  $("pvHome").addEventListener("click", function () { navigate(HOME); });
  $("pvAddr").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); goText(this.value); } });
  $("pvAddr").addEventListener("focus", function () { this.select(); });
  $("pvWin").addEventListener("click", function () { if (api) api.open_browser_window(curUrl ? cleanUrl(curUrl) : HOME).catch(noop); });
  $("pvOpen").addEventListener("click", function () {
    if (!api || !curUrl) return;
    (isLocalUrl(curUrl) && lastSite ? api.open_external(lastSite.path) : api.open_url(cleanUrl(curUrl))).catch(noop);
  });
  $("pvBlockWin").addEventListener("click", function () { if (api && curUrl) api.open_browser_window(cleanUrl(curUrl)).catch(noop); });
  $("pvBlockExt").addEventListener("click", function () { if (api && curUrl) api.open_url(cleanUrl(curUrl)).catch(noop); });
  $("pvNewest").addEventListener("click", newestSite);
  $("pvClose").addEventListener("click", closeBrowser);
  $("pvTab").addEventListener("click", openBrowser);
  $("paneToggle").addEventListener("click", function () { if (paneOpen()) closeBrowser(); else openBrowser(); });
  updNav();

  /* The assistant can ask for a website to be opened (control door -> poll_open). */
  function pollOpen() {
    api.poll_open().then(function (list) {
      if (list && list.length) { uiLog("open request: " + list[list.length - 1]); navigate(list[list.length - 1]); }
    }).catch(noop).then(function () { setTimeout(pollOpen, 1500); });
  }

  /* ---------- window: own top strip (no native title bar), sidebar, window buttons ---------- */
  var sbHidden = false;
  try { sbHidden = localStorage.getItem("auraSidebar") === "0"; } catch (e) { /* ignore */ }
  function setSidebar(show) {
    sbHidden = !show;
    document.body.classList.toggle("sb-hidden", sbHidden);
    $("sbToggle").setAttribute("aria-expanded", show ? "true" : "false");
    try { localStorage.setItem("auraSidebar", show ? "1" : "0"); } catch (e) { /* ignore */ }
    requestAnimationFrame(ovSync);
  }
  setSidebar(!sbHidden);
  function showMax(r) {
    var on = !!(r && r.max), b = $("wcMax");
    b.classList.toggle("is-max", on);
    b.title = on ? "Restore" : "Maximize"; b.setAttribute("aria-label", b.title);
  }
  function syncMax() { if (api && api.win_is_max) api.win_is_max().then(showMax).catch(noop); }
  function dragWin(e) {
    if (e.button !== 0 || !api) return;
    e.preventDefault();
    api.win_drag().then(syncMax).catch(noop);
  }
  function toggleMax() { if (api) api.win_max().then(showMax).catch(noop); }
  var maxTimer = 0;
  window.addEventListener("resize", function () { clearTimeout(maxTimer); maxTimer = setTimeout(syncMax, 250); });
  $("sbToggle").addEventListener("click", function () { setSidebar(sbHidden); });
  $("tsDrag").addEventListener("mousedown", dragWin);
  $("tsDrag").addEventListener("dblclick", toggleMax);
  document.querySelector("#sidebar .brand").addEventListener("mousedown", dragWin);
  $("wcMin").addEventListener("click", function () { if (api) api.win_min().catch(noop); });
  $("wcMax").addEventListener("click", toggleMax);
  $("wcClose").addEventListener("click", function () { if (api) api.win_close().catch(noop); });

  /* ---------- keyboard + press feedback ---------- */
  function termVisible() { return $("termView").style.display !== "none"; }
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key && e.key.toLowerCase() === "b") {
      e.preventDefault(); setSidebar(sbHidden); return;
    }
    if (e.key === "Escape" && stopFn) { e.preventDefault(); stopFn(); return; }
    // Typing anywhere goes to the text box (letters, digits, symbols; Space/Enter keep working on buttons).
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !e.key || e.key.length !== 1 || e.key === " ") return;
    var a = document.activeElement;
    if (a && (a === input || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
    if (document.querySelector(".modal-back") || termVisible() || !$("modeMenu").hidden) return;
    input.focus();
  });

  /* Keep Tab inside a dialog (focus trap). */
  function trapTab(card, e) {
    var f = Array.prototype.filter.call(card.querySelectorAll("button, select, input, textarea, [tabindex]:not([tabindex='-1'])"),
      function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (e.shiftKey && (a === first || !card.contains(a))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (a === last || !card.contains(a))) { e.preventDefault(); first.focus(); }
  }

  /* A quiet press feedback (small scale/fade dip) whenever a button or chat row is pressed. */
  document.addEventListener("click", function (e) {
    if (calmMotion || !e.target || !e.target.closest) return;
    var t = e.target.closest("button, .session");
    if (!t || t.disabled) return;
    t.classList.remove("press");
    void t.offsetWidth; // restart the animation
    t.classList.add("press");
  }, true);
  document.addEventListener("animationend", function (e) {
    if (e.animationName === "press") e.target.classList.remove("press");
  });

  /* ---------- hidden terminal mode (scripts load only on first use) ---------- */
  var term = null, fit = null, termTimer = 0;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  function loadTerminalLibs() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    var css = document.createElement("link"); css.rel = "stylesheet"; css.href = "vendor/xterm.css";
    document.head.appendChild(css);
    return loadScript("vendor/xterm.js").then(function () { return loadScript("vendor/addon-fit.js"); });
  }
  function createTerminal() {
    term = new window.Terminal({ fontSize: 15, lineHeight: 1.45, letterSpacing: 0.2, cursorBlink: true,
      cursorStyle: "bar", cursorWidth: 2, scrollback: 5000,
      fontFamily: "'Cascadia Code','Cascadia Mono',Consolas,monospace",
      theme: { background: "#0F1117", foreground: "#E6E8EE", cursor: "#4D5BFF", cursorAccent: "#0F1117",
        selectionBackground: "#2E3550", black: "#1B1E27", red: "#F2706B", green: "#7FD18B",
        yellow: "#E8C46A", blue: "#7C84F8", magenta: "#C792EA", cyan: "#6FC7D6", white: "#B3B7C4",
        brightBlack: "#5A6070", brightRed: "#FF8A85", brightGreen: "#98E2A3", brightYellow: "#F2D58A",
        brightBlue: "#9EA5FF", brightMagenta: "#D8A9F2", brightCyan: "#8FDCE8", brightWhite: "#F3F4F7" } });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($("termHost"));
    term.onData(function (d) { api.term_write(d).catch(noop); });
    term.onResize(function (s) { api.term_resize(s.cols, s.rows).catch(noop); });
    window.addEventListener("resize", function () { if (fit && termVisible()) fit.fit(); });
  }
  function readTerminal() {
    api.term_read().then(function (s) { if (s && term) term.write(s); }).catch(noop);
  }
  function showTerm(on) {
    $("main").style.display = on ? "none" : "flex";
    $("termView").style.display = on ? "flex" : "none";
    if (!on) { clearInterval(termTimer); termTimer = 0; focusInput(); return; }
    loadTerminalLibs().then(function () {
      if (!term) createTerminal();
      fit.fit();
      return api.term_start(term.cols, term.rows);
    }).then(function (r) {
      if (!r || (r.status !== "running" && r.status !== "started")) { toast((r && r.status) || "Could not start the terminal."); return; }
      if (!termTimer) termTimer = setInterval(readTerminal, 40); // only while the terminal is shown
      term.focus();
    }).catch(function () { toast("Could not start the terminal."); });
  }
  window.auraTerminal = showTerm; // hidden mode: auraTerminal(true) from the dev console

  /* ---------- start: called once the Python side is ready ---------- */
  function ready() {
    if (started || !window.pywebview || !window.pywebview.api) return;
    started = true;
    api = window.pywebview.api;
    api.get_version().then(function (v) { $("version").textContent = "v" + v; }).catch(noop);
    refreshSessions().then(function () {
      if (sessions.length && sessions[0].title === "New chat") return openSession(sessions[0].id);
      return newChat();
    });
    pollOpen();
    pollBusy();
    syncMax();
    startUpdateChecks(2700); // toast after the splash is gone
    input.focus();
  }

  input.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.isComposing) return;
    if (settings.enterSends ? !e.shiftKey : (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", autoGrow);
  sendBtn.addEventListener("click", send);
  $("stopBtn").addEventListener("click", function () { if (stopFn) stopFn(); });
  $("newChat").addEventListener("click", function () {
    if (!api) { toast("One moment, still loading."); return; }
    newChat().then(focusInput); // the chat you leave keeps working in the background
  });
  $("attachBtn").addEventListener("click", function () { $("fileIn").click(); });
  $("fileIn").addEventListener("change", function () { addFiles($("fileIn").files); $("fileIn").value = ""; focusInputSoon(); });
  $("fileIn").addEventListener("cancel", focusInputSoon);
  document.addEventListener("paste", function (e) {
    var files = (e.clipboardData && e.clipboardData.files) || [];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  var dragDepth = 0;
  function endDrag() { dragDepth = 0; document.body.classList.remove("drag"); }
  document.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add("drag"); });
  document.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("dragleave", function (e) { if (hasFiles(e) && --dragDepth <= 0) endDrag(); });
  document.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); endDrag();
    addFiles(e.dataTransfer.files);
  });
  $("backChat").addEventListener("click", function () { showTerm(false); });
  $("restartClaude").addEventListener("click", function () {
    if (!term) return;
    api.term_restart().then(function () { term.reset(); return api.term_start(term.cols, term.rows); }).catch(noop);
  });
  /* ---------- settings ---------- */
  var DEFAULTS = { size: "normal", calm: false, enterSends: true, startMode: "claude" };
  var settings = (function () {
    var o = {}, k;
    try { o = JSON.parse(localStorage.getItem("auraSettings") || "{}") || {}; } catch (e) { o = {}; }
    for (k in DEFAULTS) if (typeof o[k] !== typeof DEFAULTS[k]) o[k] = DEFAULTS[k];
    return o;
  })();
  var osCalm = calmMotion;
  function saveSettings() { try { localStorage.setItem("auraSettings", JSON.stringify(settings)); } catch (e) { /* ignore */ } }
  function applySettings() {
    document.body.classList.toggle("ts-small", settings.size === "small");
    document.body.classList.toggle("ts-large", settings.size === "large");
    document.body.classList.toggle("calm", settings.calm);
    calmMotion = osCalm || settings.calm;
    var h = $("hint");
    if (h) h.innerHTML = settings.enterSends
      ? "<kbd>Enter</kbd> send &middot; <kbd>Shift+Enter</kbd> new line &middot; <kbd>Esc</kbd> stop"
      : "<kbd>Ctrl+Enter</kbd> send &middot; <kbd>Enter</kbd> new line &middot; <kbd>Esc</kbd> stop";
    if (input.value) autoGrow(); // text size changed: re-fit the box
  }
  applySettings();

  /* ---------- updates: quiet check at start, badge on Settings, progress overlay, self-restart ---------- */
  var updAvail = "", updBusy = false, updOv = null;
  function setUpdateBadge(v) {
    updAvail = v || "";
    ["settingsBtn", "railSettings"].forEach(function (id) {
      var b = $(id); if (!b) return;
      b.classList.toggle("has-update", !!updAvail);
      b.setAttribute("aria-label", updAvail ? "Settings (update available)" : "Settings");
      b.title = updAvail ? "Settings · Update available" : "Settings";
    });
  }
  function updKey(e) {
    if (!updOv || e.altKey) return;
    var err = updOv.classList.contains("err");
    if (err && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); updHide(); return; }
    if (err && updOv.contains(e.target) && (e.key === "Tab" || e.key === "Enter" || e.key === " ")) return;
    e.preventDefault(); e.stopPropagation(); /* nothing else while Aura updates */
  }
  function updShow() {
    if (updOv) return updOv;
    updOv = document.createElement("div"); updOv.id = "updOv";
    updOv.setAttribute("role", "alertdialog"); updOv.setAttribute("aria-modal", "true");
    updOv.setAttribute("aria-labelledby", "updTitle"); updOv.setAttribute("aria-describedby", "updStep");
    updOv.innerHTML = '<div class="upd-card" tabindex="-1"><div class="upd-ring" aria-hidden="true"></div>' +
      '<h3 id="updTitle">Updating Aura</h3><p id="updStep" aria-live="polite"></p>' +
      '<div class="upd-bar" aria-hidden="true"><i></i></div>' +
      '<div class="upd-actions" hidden><button type="button" class="set-btn" id="updClose">Close</button>' +
      '<button type="button" class="set-btn primary" id="updRetry">Retry</button></div></div>';
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (!el.inert) { el.inert = true; el.setAttribute("data-upd-inert", ""); } /* no clicks or focus behind */
    });
    document.body.appendChild(updOv);
    updOv.querySelector("#updRetry").addEventListener("click", runUpdate);
    updOv.querySelector("#updClose").addEventListener("click", updHide);
    document.addEventListener("keydown", updKey, true);
    requestAnimationFrame(function () { if (updOv) { updOv.classList.add("show"); updOv.querySelector(".upd-card").focus(); } });
    return updOv;
  }
  function updHide() {
    if (!updOv || updBusy) return;
    document.removeEventListener("keydown", updKey, true);
    Array.prototype.forEach.call(document.querySelectorAll("[data-upd-inert]"), function (el) { el.inert = false; el.removeAttribute("data-upd-inert"); });
    updOv.remove(); updOv = null;
    if (!document.querySelector(".modal-back")) ovResume();
    var b = document.querySelector("#setUpBtn");
    if (b) b.focus(); else focusInput();
  }
  function updStep(text, failed) {
    var o = updShow();
    o.classList.toggle("err", !!failed);
    o.querySelector("#updTitle").textContent = failed ? "Update did not finish" : "Updating Aura";
    o.querySelector("#updStep").textContent = text;
    o.querySelector(".upd-actions").hidden = !failed;
    if (failed) o.querySelector("#updRetry").focus();
  }
  function runUpdate() {
    if (!api || updBusy) return;
    if (!updOv && guardBusy()) return; /* never cut off an answer that is still coming in */
    updBusy = true; ovSuspend();
    updStep("Downloading the update...");
    api.update_download().then(function (r) {
      if (!r || !r.ok) throw r;
      updStep("Installing...");
      return api.update_install();
    }).then(function (r) {
      if (!r || !r.ok) throw r;
      updStep("Restarting Aura...");
      return api.update_restart();
    }).then(function (r) {
      if (!r || !r.ok) throw r;
      /* this window closes in a moment and the new Aura opens by itself; the overlay stays until then */
    }).catch(function (r) {
      updBusy = false;
      updStep((r && r.status) || "The update did not finish. Aura is still running.", true);
    });
  }
  function paintUpdateRow(btn, note) {
    if (!updAvail) return;
    note.textContent = "Version " + updAvail + " is ready. Aura restarts by itself afterwards.";
    btn.textContent = "Update now"; btn.classList.add("primary");
  }
  function checkForUpdates(btn, note) {
    if (!api || btn.classList.contains("busy")) return;
    if (updAvail) { runUpdate(); return; }
    btn.classList.add("busy"); btn.setAttribute("aria-busy", "true"); note.textContent = "Checking...";
    api.check_update().then(function (r) {
      if (r && r.newer) { setUpdateBadge(r.version || "new"); paintUpdateRow(btn, note); }
      else note.textContent = (r && r.status) || "Could not check for updates right now.";
    }).catch(function () { note.textContent = "Could not check for updates right now."; })
      .then(function () { btn.classList.remove("busy"); btn.removeAttribute("aria-busy"); });
  }
  function startUpdateChecks(splashMs) {
    if (api.update_notice) api.update_notice().then(function (v) {
      if (v) setTimeout(function () { toast("Updated to v" + v); }, splashMs);
    }).catch(noop);
    setTimeout(function () { /* quiet check, never installs anything by itself */
      api.check_update().then(function (r) { if (r && r.newer) setUpdateBadge(r.version || "new"); }).catch(noop);
    }, 5000);
  }

  function openSettings() {
    if (document.querySelector(".modal-back")) return;
    ovSuspend();
    var prev = document.activeElement, closed = false;
    var back = document.createElement("div"); back.className = "modal-back";
    var card = document.createElement("div"); card.className = "modal settings";
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "setTitle");
    var X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    card.innerHTML =
      '<div class="settings-head"><h3 id="setTitle">Settings</h3><button type="button" class="settings-x" aria-label="Close">' + X + '</button></div>' +
      '<div class="settings-body">' +
      '<section class="set-sec"><h4>Updates</h4>' +
        '<div class="set-row"><div class="t"><b>Aura <span id="setVer"></span></b><small id="setUpNote">See if a newer version is ready.</small></div><button type="button" class="set-btn" id="setUpBtn">Check now</button></div></section>' +
      '<section class="set-sec"><h4>Look</h4>' +
        '<div class="set-row"><div class="t"><b>Theme</b><small>System follows your Windows setting.</small></div><div class="seg" id="setTheme" role="group" aria-label="Theme"></div></div>' +
        '<div class="set-row"><div class="t"><b>Text size</b><small>Size of the words in the chat.</small></div><div class="seg" id="setSize" role="group" aria-label="Text size"></div></div>' +
        '<div class="set-row"><div class="t"><b>Calm effects</b><small>Turns off fades and other small animations.</small></div><button type="button" class="sw" id="setCalm" role="switch" aria-label="Calm effects"></button></div></section>' +
      '<section class="set-sec"><h4>Chat</h4>' +
        '<div class="set-row"><div class="t"><b>Enter sends the message</b><small>Off: Enter makes a new line and Ctrl+Enter sends.</small></div><button type="button" class="sw" id="setEnter" role="switch" aria-label="Enter sends the message"></button></div>' +
        '<div class="set-row"><div class="t"><b>Start Aura in mode</b><small>The mode that is picked when Aura opens.</small></div><select class="set-select" id="setMode" aria-label="Start mode"></select></div></section>' +
      '<section class="set-sec"><h4>Your chats</h4>' +
        '<div class="set-row"><div class="t"><b>Save this chat as a file</b><small>A plain text file you can keep or send.</small></div><button type="button" class="set-btn" id="setExport">Save</button></div>' +
        '<div class="set-row"><div class="t"><b>Open the chats folder</b><small>Where Aura keeps your chats on this PC.</small></div><button type="button" class="set-btn" id="setFolder">Open</button></div>' +
        '<div class="set-row"><div class="t"><b>Delete all chats</b><small>Removes every chat. This can’t be undone.</small></div><button type="button" class="set-btn danger" id="setWipe">Delete all</button></div></section>' +
      '<section class="set-sec"><h4>Shortcuts</h4><div class="keys">' +
        '<kbd>Ctrl+B</kbd><span>Show or hide the chat list</span><kbd>Esc</kbd><span>Stop Aura while it is answering</span>' +
        '<kbd>Enter</kbd><span>Send (or new line, see above)</span><kbd>Shift+Enter</kbd><span>New line</span></div></section>' +
      '<section class="set-sec"><h4>About</h4><p class="set-about">Aura — your personal assistant, built by Amar &amp; Arry.</p></section>' +
      '</div><div class="set-foot"><button type="button" class="set-btn" id="setDone">Done</button></div>';
    back.appendChild(card); document.body.appendChild(back);
    requestAnimationFrame(function () { back.classList.add("show"); });
    var q = function (id) { return card.querySelector("#" + id); };

    if (api) api.get_version().then(function (v) { q("setVer").textContent = "v" + v; }).catch(noop);
    q("setUpBtn").addEventListener("click", function () { checkForUpdates(q("setUpBtn"), q("setUpNote")); });
    paintUpdateRow(q("setUpBtn"), q("setUpNote"));

    var seg = q("setSize");
    function paintSeg() { Array.prototype.forEach.call(seg.children, function (b) { var on = b.dataset.v === settings.size; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); }); }
    [["small", "Small"], ["normal", "Normal"], ["large", "Large"]].forEach(function (o) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = o[1]; b.dataset.v = o[0];
      b.addEventListener("click", function () { settings.size = o[0]; saveSettings(); applySettings(); paintSeg(); });
      seg.appendChild(b);
    });
    function toggle(id, key) {
      var b = q(id);
      function paint() { b.setAttribute("aria-checked", settings[key] ? "true" : "false"); }
      b.addEventListener("click", function () { settings[key] = !settings[key]; saveSettings(); applySettings(); paint(); });
      paint();
    }
    toggle("setCalm", "calm"); toggle("setEnter", "enterSends"); paintSeg();
    var tseg = q("setTheme"), TH = window.auraTheme;
    function paintTheme() { Array.prototype.forEach.call(tseg.children, function (b) { var on = TH && b.dataset.v === TH.get(); b.classList.toggle("on", !!on); b.setAttribute("aria-pressed", on ? "true" : "false"); }); }
    [["auto", "System"], ["light", "Light"], ["dark", "Dark"]].forEach(function (o) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = o[1]; b.dataset.v = o[0];
      b.addEventListener("click", function () { if (TH) TH.set(o[0]); paintTheme(); });
      tseg.appendChild(b);
    });
    paintTheme();
    var sel = q("setMode");
    MODES.forEach(function (m) { var o = document.createElement("option"); o.value = m.id; o.textContent = m.label; sel.appendChild(o); });
    sel.value = settings.startMode;
    sel.addEventListener("change", function () { settings.startMode = sel.value; saveSettings(); });

    q("setExport").addEventListener("click", function () {
      if (!api || !currentId) { toast("Open a chat first."); return; }
      api.export_chat(currentId).then(function (r) { toast((r && r.status) || "Could not save the chat."); }).catch(function () { toast("Could not save the chat."); });
    });
    q("setFolder").addEventListener("click", function () {
      if (api) api.open_chats_folder().then(function (r) { if (r && r.status !== "Opened.") toast(r.status); }).catch(noop);
    });
    q("setWipe").addEventListener("click", function () {
      if (!api || guardBusy()) return;
      askConfirm({ title: "Delete all chats?", text: "Every chat (" + sessions.length + ") and all its messages will be removed. This can’t be undone.", ok: "Delete all", danger: true })
        .then(function (yes) {
          if (!yes) return;
          return api.delete_all_sessions().then(function () {
            currentId = null; messagesEl.textContent = "";
            return refreshSessions().then(newChat);
          }).then(function () { toast("All chats deleted."); });
        }).catch(function () { toast("Could not delete the chats."); });
    });

    function close() {
      if (closed) return; closed = true;
      document.removeEventListener("keydown", onKey, true);
      back.classList.remove("show");
      setTimeout(function () {
        back.remove(); ovResume();
        if (prev && prev.focus && document.contains(prev)) { try { prev.focus(); } catch (e) { /* ignore */ } } else focusInput();
      }, 180);
    }
    function onKey(e) {
      /* Esc closes settings only when no confirm dialog is stacked on top of it */
      if (document.querySelectorAll(".modal-back").length !== 1) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Tab") trapTab(card, e);
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("mousedown", function (e) { if (e.target === back) close(); });
    card.querySelector(".settings-x").addEventListener("click", close);
    q("setDone").addEventListener("click", close);
    q("setDone").focus();
  }
  $("settingsBtn").addEventListener("click", openSettings);
  buildPills();
  MODES.forEach(function (m) { if (m.id === settings.startMode && m.id !== mode) setMode(m); });

  /* ---------- loading screen: Hermes particle loader + "Connecting…", hidden after about 2.4 s (300 ms fade) ---------- */
  (function () {
    var s = $("splash"), t0 = Date.now();
    if (!s) return;
    var host = $("spLoader"), stopLoader = host && window.auraLoader ? window.auraLoader(host) : null;
    function hide() {
      setTimeout(function () {
        s.classList.add("hide");
        setTimeout(function () { if (stopLoader) stopLoader(); s.remove(); }, 400);
      }, Math.max(0, 2400 - (Date.now() - t0)));
    }
    if (document.readyState === "complete") hide(); else window.addEventListener("load", hide);
  })();

  /* ---------- front page: now the #welcome block in index.html (dataset kept for compatibility) ---------- */
  messagesEl.dataset.typed = "What shall we build?";

  if (window.pywebview && window.pywebview.api) ready();
  window.addEventListener("pywebviewready", ready);
})();

/* ---------- Hermes-style cosmetics only (no app logic): icon rail, chat filter, top-bar title,
   send-button state, scroll-to-bottom button, light/dark switch ---------- */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement, body = document.body;
  var forward = function (railId, targetId) {
    var r = $(railId), t = $(targetId);
    if (r && t) r.addEventListener("click", function () { t.click(); });
  };

  // theme: follows Windows ("auto") until the user picks light or dark; the choice is remembered
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function isLight() { var t = root.dataset.theme; return t === "light" || (t !== "dark" && !!mq && mq.matches); }
  function paintTheme() { root.classList.toggle("is-light", isLight()); }
  function setTheme(t) {
    root.dataset.theme = t;
    try { localStorage.setItem("auraTheme", t); } catch (e) { /* ignore */ }
    paintTheme();
  }
  try { var th = localStorage.getItem("auraTheme"); root.dataset.theme = (th === "light" || th === "dark") ? th : "auto"; } catch (e) { root.dataset.theme = "auto"; }
  paintTheme();
  if (mq) { if (mq.addEventListener) mq.addEventListener("change", paintTheme); else if (mq.addListener) mq.addListener(paintTheme); }
  window.auraTheme = { get: function () { return root.dataset.theme; }, set: setTheme };
  $("railTheme").addEventListener("click", function () { setTheme(isLight() ? "dark" : "light"); });

  // rail buttons forward to the real controls
  forward("railChat", "sbToggle");
  forward("railNew", "newChat");
  forward("railBrowser", "paneToggle");
  forward("railSettings", "settingsBtn");
  $("railLogo").addEventListener("mousedown", function (e) {
    var b = document.querySelector("#sidebar .brand");
    if (b && e.button === 0) b.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  });
  function syncRail() {
    $("railChat").classList.toggle("on", !body.classList.contains("sb-hidden"));
    $("railBrowser").classList.toggle("on", $("preview").classList.contains("open"));
  }
  new MutationObserver(syncRail).observe(body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(syncRail).observe($("preview"), { attributes: true, attributeFilter: ["class"] });
  syncRail();

  // chat filter (client-side, on the rendered rows) + centered title of the open chat
  var list = $("sessionList"), filter = $("chatFilter"), title = $("chatTitle");
  var noMatch = document.createElement("div");
  noMatch.className = "side-empty"; noMatch.setAttribute("role", "status");
  noMatch.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg><span>No chats match</span>';
  function applyFilter() {
    var q = filter.value.trim().toLowerCase(), shown = 0;
    if (q) { var more = list.querySelector('.more-chats[aria-expanded="false"]'); if (more) { more.click(); return; } }
    var rows = list.querySelectorAll(".session");
    Array.prototype.forEach.call(rows, function (row) {
      var out = !!q && (row.title || row.textContent).toLowerCase().indexOf(q) < 0;
      row.classList.toggle("filtered-out", out);
      if (!out) shown++;
    });
    var want = !!q && rows.length > 0 && shown === 0;
    if (want && noMatch.parentNode !== list) list.appendChild(noMatch);
    else if (!want && noMatch.parentNode) noMatch.remove();
  }
  // arrow keys move between chat rows
  list.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    var a = document.activeElement, cur = a && a.closest ? a.closest(".session, .more-chats") : null;
    if (!cur) return;
    var rows = Array.prototype.filter.call(list.querySelectorAll(".session, .more-chats"), function (r) { return !r.classList.contains("filtered-out"); });
    var i = rows.indexOf(cur); if (i < 0) return;
    e.preventDefault();
    var n = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    rows[n].focus();
  });
  function syncTitle() {
    var a = list.querySelector(".session.active span");
    var t = a ? a.textContent : "";
    if (title.textContent !== t) title.textContent = t;
  }
  filter.addEventListener("input", applyFilter);
  filter.addEventListener("keydown", function (e) { if (e.key === "Escape" && filter.value) { e.stopPropagation(); filter.value = ""; applyFilter(); } });
  new MutationObserver(function (recs) {
    // ignore the observer's own "no matches" note going in or out (avoids a feedback loop)
    if (recs.every(function (r) { return Array.prototype.every.call(r.addedNodes, function (n) { return n === noMatch; })
      && Array.prototype.every.call(r.removedNodes, function (n) { return n === noMatch; }); })) return;
    applyFilter(); syncTitle();
  }).observe(list, { childList: true });
  syncTitle();

  // send button turns accent when there is text
  var input = $("input"), composer = $("composer");
  function syncSend() { composer.classList.toggle("has-text", input.value.trim().length > 0); }
  ["input", "change"].forEach(function (ev) { input.addEventListener(ev, syncSend); }); // the app fires "input" after clearing the box

  // round scroll-to-bottom button
  var msgs = $("messages"), down = $("toBottom");
  function syncDown() { down.classList.toggle("show", msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight > 240); }
  msgs.addEventListener("scroll", syncDown);
  new MutationObserver(syncDown).observe(msgs, { childList: true });
  down.addEventListener("click", function () { msgs.scrollTo({ top: msgs.scrollHeight, behavior: "smooth" }); input.focus(); });

  // mode picker (Hermes model-menu style): menu items .click() the hidden real pills, so the app logic is unchanged
  var DESC = {
    claude: "Everyday work, hands tasks to the builder",
    auto: "Fast local answer, escalates if needed",
    qwen: "Runs only on this PC, free",
    big: "Plans and builds larger projects",
    polish: "One careful design and quality pass"
  };
  var pills = $("pills"), modeBtn = $("modeBtn"), modeLabel = $("modeLabel"), menu = $("modeMenu"), kb = -1;
  var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  function items() { return Array.prototype.slice.call(menu.children); }
  function buildMenu() {
    menu.textContent = "";
    Array.prototype.forEach.call(pills.children, function (p) {
      p.tabIndex = -1;
      var it = document.createElement("button");
      it.type = "button"; it.className = "mode-item"; it.setAttribute("role", "menuitemradio"); it.tabIndex = -1;
      it.dataset.id = p.dataset.id;
      var b = document.createElement("b"); b.textContent = p.textContent;
      var s = document.createElement("small"); s.textContent = DESC[p.dataset.id] || p.title || "";
      var t = document.createElement("span"); t.append(b, s);
      it.appendChild(t); it.insertAdjacentHTML("beforeend", CHECK);
      it.addEventListener("click", function () { p.click(); closeMenu(true); });
      it.addEventListener("mousemove", function () { setKb(items().indexOf(it), false); });
      menu.appendChild(it);
    });
    syncMode();
  }
  function syncMode() {
    var act = pills.querySelector(".pill.active");
    if (act && modeLabel.textContent !== act.textContent) modeLabel.textContent = act.textContent;
    items().forEach(function (it) { it.setAttribute("aria-checked", act && it.dataset.id === act.dataset.id ? "true" : "false"); });
  }
  function setKb(i, focus) {
    var list = items(); if (!list.length) return;
    kb = (i + list.length) % list.length;
    list.forEach(function (it, j) { it.classList.toggle("kb", j === kb); });
    if (focus) list[kb].focus();
  }
  var hideTimer = 0;
  function isOpen() { return modeBtn.getAttribute("aria-expanded") === "true"; }
  function openMenu() {
    if (!menu.children.length) buildMenu();
    clearTimeout(hideTimer);
    menu.hidden = false; modeBtn.setAttribute("aria-expanded", "true");
    void menu.offsetWidth; menu.classList.add("in"); // fade/slide in
    var list = items(), cur = list.findIndex(function (it) { return it.getAttribute("aria-checked") === "true"; });
    setKb(cur < 0 ? 0 : cur, true);
  }
  function closeMenu(refocus) {
    if (!isOpen()) return;
    modeBtn.setAttribute("aria-expanded", "false"); kb = -1;
    menu.classList.remove("in"); // fade out, then hide
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (!isOpen()) menu.hidden = true; }, 150);
    items().forEach(function (it) { it.classList.remove("kb"); });
    if (refocus) modeBtn.focus();
  }
  modeBtn.addEventListener("click", function () { if (!isOpen()) openMenu(); else closeMenu(true); });
  modeBtn.addEventListener("keydown", function (e) {
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !isOpen()) { e.preventDefault(); openMenu(); }
  });
  menu.addEventListener("keydown", function (e) {
    var list = items();
    if (e.key === "ArrowDown") { e.preventDefault(); setKb(kb + 1, true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setKb(kb - 1, true); }
    else if (e.key === "Home") { e.preventDefault(); setKb(0, true); }
    else if (e.key === "End") { e.preventDefault(); setKb(list.length - 1, true); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (list[kb]) list[kb].click(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === "Tab") { closeMenu(false); }
  });
  document.addEventListener("mousedown", function (e) {
    if (isOpen() && !menu.contains(e.target) && !modeBtn.contains(e.target)) closeMenu(false);
  }, true);
  // pills are built by the app at startup and their "active" class changes with every mode switch (also by Settings)
  new MutationObserver(function (recs) {
    if (recs.some(function (r) { return r.type === "childList"; })) buildMenu(); else syncMode();
  }).observe(pills, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  if (pills.children.length) buildMenu();
})();
