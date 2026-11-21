/* =====================================================================
   Aura - the page logic.
   Talks to the Python side through window.pywebview.api (see app/app.py).
   Sections: basics, rich text, messages + status line, chats list,
   pictures, sending, modes, composer, dialog, browser pane, window,
   keyboard, terminal (hidden mode), loading screen, front page, start.
   ===================================================================== */
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
  function codeBlock(code, lang) {
    var wrap = document.createElement("div"); wrap.className = "code";
    var bar = document.createElement("div"); bar.className = "code-bar";
    var l = document.createElement("span"); l.textContent = lang || "code";
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "copy"; btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.addEventListener("click", function () {
      copyText(code).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
    });
    bar.appendChild(l); bar.appendChild(btn);
    var pre = document.createElement("pre"), c = document.createElement("code");
    c.textContent = code;
    pre.appendChild(c);
    wrap.appendChild(bar); wrap.appendChild(pre);
    return wrap;
  }
  function renderRich(el, text) {
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
    if (role === "assistant" && !kind) renderRich(b, text); else b.textContent = text;
    wrap.appendChild(b);
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
    polish: { seq: true,  words: ["Reviewing", "Looking for rough edges", "Polishing", "Refining the details", "Final checks"] }
  };
  var CHIP = { read: "Read files", search: "Searched", edit: "Edited files", run: "Ran a command", work: "Completed a task",
               build: "Built and tested", web: "Looked something up", plan: "Planned the steps" };

  /* Creates the status line at the bottom of the chat. Returns { el, phase(p), stop() }. */
  function startStatus(phase) {
    messagesEl.querySelectorAll(".working").forEach(function (o) { o.remove(); }); // never show two
    var w = document.createElement("div");
    w.className = "working";
    w.setAttribute("role", "status");
    var g = document.createElement("span"); g.className = "st-glyph"; g.setAttribute("aria-hidden", "true"); g.textContent = GLYPHS[4];
    var v = document.createElement("span"); v.className = "st-verb";
    var m = document.createElement("span"); m.className = "st-meta";
    w.appendChild(g); w.appendChild(v); w.appendChild(m);
    messagesEl.appendChild(w);
    scrollDown();

    var cur = STATUS[phase] ? phase : "think", idx = -1, last = "", t0 = Date.now(), gi = 4, ticks = 0, nextWord = 0;
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
      if (!calmMotion) { gi = (gi + 1) % GLYPHS.length; g.textContent = GLYPHS[gi]; }
      if (calmMotion || ++ticks % 7 === 0) meta();
      if (Date.now() >= nextWord) pick();
    }, calmMotion ? 1000 : 140);
    return {
      el: w,
      phase: function (p) { if (p === "act") p = "work"; if (p !== cur && STATUS[p]) { cur = p; idx = -1; pick(); } },
      stop: function () { clearInterval(timer); w.remove(); }
    };
  }

  function setBusy(on, canStop) {
    busy = on;
    sendBtn.disabled = on;
    document.body.classList.toggle("can-stop", !!(on && canStop));
    if (!on) { stopFn = null; input.focus(); }
  }
  function guardBusy() {
    if (!busy) return false;
    toast(stopFn ? "Aura is still answering. Press Stop first." : "Please wait until Aura is finished.");
    return true;
  }

  /* ---------- chats list (latest 7, then "Show all") ---------- */
  var RECENT = 7, showAllChats = false;
  function sessionRow(s) {
    var row = document.createElement("div");
    var active = s.id === currentId, title = s.title || "New chat";
    row.className = "session" + (active ? " active" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    if (active) row.setAttribute("aria-current", "true");
    row.title = title;
    var span = document.createElement("span");
    span.textContent = title;
    var del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "×";
    del.title = "Delete chat";
    del.setAttribute("aria-label", "Delete chat " + title);
    del.addEventListener("click", function (e) { e.stopPropagation(); deleteChat(s); });
    row.appendChild(span);
    row.appendChild(del);
    row.addEventListener("click", function () { if (s.id !== currentId && !guardBusy()) openSession(s.id); });
    row.addEventListener("keydown", function (e) {
      if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
    });
    return row;
  }
  function renderSessions() {
    var list = $("sessionList"), frag = document.createDocumentFragment();
    var lbl = document.querySelector(".side-label");
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
      showAllChats = !showAllChats; renderSessions();
      if (!showAllChats) list.scrollTop = 0;
      var again = list.querySelector(".more-chats"); if (again) again.focus();
    });
    return more;
  }
  function deleteChat(s) {
    if (busy && currentId === s.id) { guardBusy(); return; }
    askConfirm({ title: "Delete this chat?", text: "“" + (s.title || "New chat") + "” and all its messages will be removed. This can’t be undone.",
                 ok: "Delete", danger: true }).then(function (yes) {
      if (!yes) return;
      return api.delete_session(s.id).then(function (ok) {
        if (!ok) toast("Could not delete this chat.");
        else if (currentId === s.id) { currentId = null; messagesEl.textContent = ""; }
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
  function openSession(id) {
    currentId = id;
    messagesEl.textContent = "";
    messagesEl.classList.add("loading"); // no front-page flash while the chat loads
    renderSessions();
    return api.load_session(id).then(function (data) {
      if (currentId !== id) return;
      if (data && data.error) { addBubble("assistant", "This chat could not be opened.", "error"); return; }
      ((data && data.messages) || []).forEach(function (m) {
        var text = (m.text || "").replace(/^\[[A-Za-z]+\]\s?/, ""); // drop the internal [Who] tag
        addBubble(m.role === "user" ? "user" : "assistant", text);
      });
      scrollDown(true);
    }).catch(function () {
      if (currentId === id) addBubble("assistant", "This chat could not be opened.", "error");
    }).then(function () { messagesEl.classList.remove("loading"); });
  }
  function newChat() {
    return api.new_session().then(function (id) {
      if (!id) throw new Error("no id");
      currentId = id;
      messagesEl.textContent = "";
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

  /* Aura mode: streaming answer from the chat's background process. */
  function sendAura(text, images) {
    var sid = currentId, st = startStatus(images.length ? "look" : "think");
    var stopWatch = watchSites(Date.now() / 1000 - 1);
    var finished = false, parts = [], cur = null, pending = null, raf = 0, timer = 0, delay = 80;
    function flush() {
      raf = 0;
      if (pending) { renderRich(pending.el, pending.text); scrollDown(); }
      pending = null;
    }
    function keepStatusLast() { messagesEl.appendChild(st.el); scrollDown(); }
    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (raf) { cancelAnimationFrame(raf); flush(); }
      st.stop();
      stopWatch();
      setBusy(false);
      refreshSessions();
    }
    function newBubble() { cur = addBubble("assistant", ""); parts.push(""); keepStatusLast(); }
    function handle(e) {
      if (e.t === "new_bubble") {
        newBubble();
      } else if (e.t === "text") {
        st.phase("write");
        if (!cur) newBubble();
        parts[parts.length - 1] = e.text || "";
        pending = { el: cur, text: e.text || "" };
        if (!raf) raf = requestAnimationFrame(flush);
      } else if (e.t === "tool") {
        addChip("▸ " + (CHIP[e.kind] || e.text || "Completed a task"));
        cur = null; st.phase(e.kind || "work"); keepStatusLast();
      } else if (e.t === "done") {
        if (e.error) addBubble("assistant", e.text || "Something went wrong. Please try again.", "error");
        done(); return true;
      } else if (e.t === "closed") {
        addBubble("assistant", "Aura stopped unexpectedly. Please send your message again.", "error");
        done(); return true;
      }
      return false;
    }
    function poll() {
      if (finished) return;
      api.chat_poll(sid).then(function (lines) {
        lines = lines || [];
        for (var k = 0; k < lines.length; k++) {
          var e; try { e = JSON.parse(lines[k]); } catch (x) { continue; }
          if (handle(e)) return;
        }
        delay = lines.length ? 80 : Math.min(delay + 40, 400); // fast while text flows, calmer while waiting
        if (!finished) timer = setTimeout(poll, delay);
      }).catch(function () { if (!finished) timer = setTimeout(poll, 600); });
    }
    stopFn = function () {
      if (finished) return;
      var partial = parts.filter(function (p) { return p.trim(); }).join("\n\n");
      api.chat_stop(sid).catch(noop);
      if (partial) api.chat_save(sid, partial).catch(noop);
      addBubble("assistant", "Stopped.", "note");
      done();
    };
    setBusy(true, true);
    api.chat_send(sid, text, images.length ? images : null).then(function (r) {
      if (finished) return;
      if (!r || !r.ok) { addBubble("assistant", (r && r.error) || "Aura could not start. Please try again.", "error"); done(); return; }
      poll();
    }).catch(function () {
      addBubble("assistant", "Aura could not start. Please try again.", "error");
      done();
    });
  }

  /* Quick, Local, Big project, Polish: one answer when it is finished. */
  function sendOnce(text, images) {
    var sid = currentId;
    var st = startStatus(mode === "big" ? "big" : mode === "polish" ? "polish" : (images.length ? "look" : "think"));
    var stopWatch = watchSites(Date.now() / 1000 - 1);
    setBusy(true, false);
    api.send_message(sid, text, mode, images.length ? images : null).then(function (res) {
      st.stop();
      if (currentId !== sid) return;
      var reply = (res && res.reply) || "No answer.";
      var failed = !res || res.error || /^Error:/.test(reply);
      addBubble("assistant", failed ? reply.replace(/^Error:\s*/, "") : reply, failed ? "error" : null);
      return refreshSessions();
    }).catch(function () {
      st.stop();
      addBubble("assistant", "Something went wrong. Please try again.", "error");
    }).then(function () { stopWatch(); setBusy(false); });
  }

  function send() {
    var text = input.value.trim();
    if ((!text && !pics.length && !docs.length) || busy) return;
    if (!api || !currentId) { toast("One moment, the chat is still loading."); return; }
    var images = pics.slice(), files = docs.slice(), shown = text;
    if (images.length && (mode === "big" || mode === "polish")) { toast("Pictures work in Aura, Quick and Local modes."); return; }
    pics = []; docs = []; renderThumbs();
    input.value = "";
    autoGrow();
    if (files.length) {
      shown = (shown + "\nAttached: " + files.map(function (f) { return f.name; }).join(", ")).trim();
      text = (text + "\n\n[Attached files. Read them from these paths:\n" + files.map(function (f) { return f.path; }).join("\n") + "]").trim();
    }
    var ub = addBubble("user", shown);
    images.forEach(function (p) {
      var im = document.createElement("img"); im.src = picUrl(p); im.alt = "Sent picture";
      ub.insertBefore(im, ub.firstChild);
    });
    if (mode === "claude") sendAura(text, images); else sendOnce(text, images);
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

  /* The blinking Aura block IS the text cursor (the native caret is hidden in CSS); it follows the typing position. */
  (function () {
    var caret = $("tcaret"), mirror = document.createElement("div"), queued = false, styled = false;
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = "position:absolute;visibility:hidden;top:0;left:0;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;height:auto;pointer-events:none;box-sizing:content-box";
    input.parentNode.appendChild(mirror);
    var mark = document.createElement("span"); mark.textContent = "​";
    function copyStyle() {
      var cs = getComputedStyle(input);
      ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "textTransform", "tabSize"]
        .forEach(function (k) { mirror.style[k] = cs[k]; });
      mirror.style.width = (input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) + "px";
      mirror._lh = parseFloat(cs.lineHeight) || 22;
      styled = true;
    }
    function place() {
      queued = false;
      if (!styled) copyStyle();
      var pos = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      mirror.textContent = input.value.slice(0, pos);
      mirror.appendChild(mark);
      caret.style.transform = "translate(" + (input.offsetLeft + mark.offsetLeft - input.scrollLeft) + "px,"
        + (input.offsetTop + mark.offsetTop - input.scrollTop + Math.max(0, (mirror._lh - 16) / 2)) + "px)";
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(place); } }
    function restyle() { styled = false; queue(); }
    ["input", "keydown", "keyup", "click", "focus", "select", "scroll"].forEach(function (ev) { input.addEventListener(ev, queue); });
    document.addEventListener("selectionchange", function () { if (document.activeElement === input) queue(); });
    window.addEventListener("resize", restyle);
    if (window.ResizeObserver) new ResizeObserver(restyle).observe(input);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(restyle);
    queue();
  })();

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
    if (document.querySelector(".modal-back") || termVisible()) return;
    input.focus();
  });

  /* A short glitch whenever a button or chat row is pressed. */
  document.addEventListener("click", function (e) {
    if (calmMotion || !e.target || !e.target.closest) return;
    var t = e.target.closest("button, .session");
    if (!t || t.disabled) return;
    t.classList.remove("glitch-press");
    void t.offsetWidth; // restart the animation
    t.classList.add("glitch-press");
  }, true);
  document.addEventListener("animationend", function (e) {
    if (e.animationName === "pressGlitch") e.target.classList.remove("glitch-press");
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
      theme: { background: "#07070a", foreground: "#d8d8de", cursor: "#4747ff", cursorAccent: "#07070a",
        selectionBackground: "#2a2a6e", black: "#07070a", red: "#e06c6c", green: "#8fbf9a",
        yellow: "#d6c08a", blue: "#7f8fff", magenta: "#9a9ab8", cyan: "#8fb8c4", white: "#d8d8de",
        brightBlack: "#5a5a64", brightRed: "#ff8a8a", brightGreen: "#a8d6b2", brightYellow: "#e8d4a2",
        brightBlue: "#a0acff", brightMagenta: "#b8b8d0", brightCyan: "#a8d0da", brightWhite: "#f2f2f5" } });
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
    syncMax();
    startUpdateChecks(3600); // toast after the glitch splash is gone
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
    if (!guardBusy()) newChat().then(focusInput);
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
      ? "<kbd>ENTER</kbd> send &middot; <kbd>SHIFT+ENTER</kbd> new line &middot; <kbd>ESC</kbd> stop"
      : "<kbd>CTRL+ENTER</kbd> send &middot; <kbd>ENTER</kbd> new line &middot; <kbd>ESC</kbd> stop";
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
        '<div class="set-row"><div class="t"><b>Text size</b><small>Size of the words in the chat.</small></div><div class="seg" id="setSize" role="group" aria-label="Text size"></div></div>' +
        '<div class="set-row"><div class="t"><b>Calm effects</b><small>Turns off the glitch and flicker animations.</small></div><button type="button" class="sw" id="setCalm" role="switch" aria-label="Calm effects"></button></div></section>' +
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
      if (e.key === "Escape" && document.querySelectorAll(".modal-back").length === 1) { e.preventDefault(); e.stopPropagation(); close(); }
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

  /* ---------- loading screen: glitching AURA, hidden after about 3.2 s ---------- */
  (function () {
    var s = $("splash"), t0 = Date.now();
    if (!s) return;
    function hide() {
      setTimeout(function () { s.classList.add("hide"); setTimeout(function () { s.remove(); }, 700); },
                 Math.max(0, 3200 - (Date.now() - t0)));
    }
    if (document.readyState === "complete") hide(); else window.addEventListener("load", hide);
  })();

  /* Random slices, shifts, jitter and scrambled letters in quick bursts (stops when the splash is gone). */
  (function () {
    var n = document.querySelector("#splash .name");
    if (!n || calmMotion) return;
    var base = n.getAttribute("data-text") || "AURA", junk = "#@%&$?/|<>01*+=";
    var tint = ["#ffffff", "#05d9e8", "#ff2a6d", "#fcee0a"], letters = [];
    n.textContent = "";
    base.split("").forEach(function (ch) { var sp = document.createElement("span"); sp.textContent = ch; n.appendChild(sp); letters.push(sp); });
    function r(a, b) { return a + Math.random() * (b - a); }
    function junkChar() { return junk.charAt(Math.floor(Math.random() * junk.length)); }
    function alive() { return document.body.contains(n); }
    function band(k) {
      var top = r(0, 85), h = r(6, 34);
      n.style.setProperty("--" + k + "1", top.toFixed(1) + "%");
      n.style.setProperty("--" + k + "2", Math.max(0, 100 - top - h).toFixed(1) + "%");
      n.style.setProperty("--" + k + "x", ((Math.random() < .5 ? -1 : 1) * r(10, 46)).toFixed(0) + "px");
    }
    function resetLetter(sp, i) {
      sp.style.transform = ""; sp.style.clipPath = ""; sp.style.opacity = ""; sp.style.color = ""; sp.style.textShadow = "";
      sp.textContent = base.charAt(i);
    }
    function clear() {
      ["a", "b"].forEach(function (k) { n.style.setProperty("--" + k + "1", "0%"); n.style.setProperty("--" + k + "2", "100%"); n.style.setProperty("--" + k + "x", "0px"); });
      n.style.transform = ""; n.style.filter = ""; n.style.color = ""; n.style.textShadow = "";
      n.setAttribute("data-text", base);
      letters.forEach(resetLetter);
    }
    function scramble() {
      var t = base.split("");
      t[Math.floor(Math.random() * t.length)] = junkChar();
      if (Math.random() < .4) t[Math.floor(Math.random() * t.length)] = junkChar();
      n.setAttribute("data-text", t.join(""));
    }
    function glitchLetter(sp, i) {
      if (Math.random() >= .62) { resetLetter(sp, i); return; }
      var top = r(0, 70), cut = r(15, 60), col = tint[Math.floor(Math.random() * tint.length)];
      sp.style.transform = "translate(" + r(-18, 18).toFixed(0) + "px," + r(-10, 10).toFixed(0) + "px) skewX(" + r(-26, 26).toFixed(0) + "deg) scaleY(" + r(.6, 1.7).toFixed(2) + ")";
      sp.style.clipPath = Math.random() < .55 ? "inset(" + top.toFixed(0) + "% 0 " + Math.max(0, 100 - top - cut).toFixed(0) + "% 0)" : "";
      sp.style.opacity = Math.random() < .2 ? "0" : (Math.random() < .3 ? ".4" : "");
      sp.style.color = col === "#ffffff" ? "" : col;
      sp.style.textShadow = col === "#ffffff" ? "" : "0 0 14px " + col;
      sp.textContent = Math.random() < .35 ? junkChar() : base.charAt(i);
    }
    function burst() {
      if (!alive()) return;
      var frames = 4 + Math.floor(Math.random() * 8), f = 0;
      (function step() {
        if (!alive()) return;
        if (f++ >= frames) { clear(); setTimeout(burst, r(220, 900)); return; }
        band("a"); band("b");
        if (Math.random() < .55) scramble(); else n.setAttribute("data-text", base);
        letters.forEach(glitchLetter);
        n.style.transform = "translate(" + r(-9, 9).toFixed(0) + "px," + r(-3, 3).toFixed(0) + "px) skewX(" + r(-12, 12).toFixed(0) + "deg)";
        n.style.filter = Math.random() < .3 ? "brightness(" + r(1.4, 2.4).toFixed(1) + ")" : "";
        var yellow = Math.random() < .28;
        n.style.color = yellow ? "#fcee0a" : "";
        n.style.textShadow = yellow ? "0 0 18px rgba(252,238,10,.6)" : "";
        setTimeout(step, r(35, 85));
      })();
    }
    setTimeout(burst, 700);
  })();

  /* ---------- front page: "AWAITING INPUT_" types, blinks, erases, repeats (only while the chat is empty) ---------- */
  (function () {
    var full = "AWAITING INPUT", i = 0, phase = "type", hold = 0, timer = 0, on = false;
    if (calmMotion) { messagesEl.dataset.typed = full + "_"; return; }
    messagesEl.dataset.typed = "";
    function tick() {
      timer = 0;
      if (messagesEl.childElementCount) return; // paused; wake() restarts it when the chat is empty again
      var delay = 110;
      if (phase === "type") {
        i++; messagesEl.dataset.typed = full.slice(0, i) + "_"; delay = 70 + Math.random() * 110;
        if (i >= full.length) { phase = "hold"; hold = 0; }
      } else if (phase === "hold") {
        hold++; messagesEl.dataset.typed = full + (hold % 2 ? "" : "_"); delay = 420;
        if (hold >= 9) phase = "erase";
      } else {
        i--; messagesEl.dataset.typed = full.slice(0, Math.max(i, 0)) + "_"; delay = 45;
        if (i <= 0) { phase = "type"; i = 0; delay = 700; }
      }
      timer = setTimeout(tick, delay);
    }
    function wake() {
      if (!on || timer || messagesEl.childElementCount) return;
      i = 0; phase = "type"; messagesEl.dataset.typed = "_";
      timer = setTimeout(tick, 400);
    }
    if (window.MutationObserver) new MutationObserver(wake).observe(messagesEl, { childList: true });
    setTimeout(function () { on = true; wake(); }, 3700); // starts after the loading screen
  })();

  if (window.pywebview && window.pywebview.api) ready();
  window.addEventListener("pywebviewready", ready);
})();
