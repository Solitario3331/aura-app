"""Message actions in both looks: Reply (quote), Edit (your own messages), Try again (last answer)."""
from pathlib import Path

APP = Path(__file__).parent

HELP = r'''
  /* ---------- message actions: copy, reply (quote), edit (your messages), try again (last answer) ---------- */
  var editing = false;
  var ICO = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>',
    ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6L4 12l6 6"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19z"/><path d="M14 7l3 3"/></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/></svg>'
  };
  function actBtn(cls, label, svg, fn) {
    var x = document.createElement("button");
    x.type = "button"; x.className = "act " + cls; x.title = label; x.setAttribute("aria-label", label);
    x.innerHTML = svg; x.addEventListener("click", fn);
    return x;
  }
  function rawOf(b) { return (b._raw != null ? b._raw : b.innerText) || ""; }
  function putInInput(text) {
    input.value = text; input.dispatchEvent(new Event("input")); autoGrow(); focusInput();
    try { input.setSelectionRange(text.length, text.length); } catch (x) { /* ignore */ }
  }
  function quoteReply(b) {
    var t = rawOf(b).replace(/\s+/g, " ").trim();
    if (!t) return;
    if (t.length > 160) t = t.slice(0, 157) + "...";
    putInInput("Re: “" + t + "”\n");
  }
  function editMessage(b) {
    if (busy) { toast("Wait for Aura to finish first, or press Stop."); return; }
    var t = rawOf(b).replace(/^\(edited\) /, "").replace(/\nAttached: [^\n]*$/, "").trim();
    if (!t) return;
    editing = true; putInInput(t);
  }
  function tryAgain() {
    if (busy) { toast("Wait for Aura to finish first, or press Stop."); return; }
    if (pics.length || docs.length) { toast("Send or remove your attachment first."); return; }
    var draft = input.value;
    input.value = "Please try again with a different answer.";
    send();
    input.value = draft; autoGrow();
  }
  function extraActions(acts, b, role) {
    acts.appendChild(actBtn("reply", "Reply to this message", ICO.reply, function () { quoteReply(b); }));
    if (role === "user") acts.appendChild(actBtn("edit", "Edit and send again", ICO.edit, function () { editMessage(b); }));
    else acts.appendChild(actBtn("regen", "Try again (another answer)", ICO.redo, tryAgain));
  }
  function ownCopy(b) {
    var btn = actBtn("copy", "Copy message", ICO.copy, function () {
      copyText(rawOf(b)).then(function () {
        btn.innerHTML = ICO.ok; btn.classList.add("done");
        setTimeout(function () { btn.innerHTML = ICO.copy; btn.classList.remove("done"); }, 1500);
      });
    });
    return btn;
  }
  /* "Try again" only shows on the very last message, and only when that is an answer. */
  function markLastReply() {
    var all = messagesEl.querySelectorAll(".msg"), last = all.length ? all[all.length - 1] : null;
    Array.prototype.forEach.call(messagesEl.querySelectorAll(".msg.last-reply"), function (m) { if (m !== last) m.classList.remove("last-reply"); });
    if (last && last.classList.contains("assistant") && last.querySelector(".act.regen")) last.classList.add("last-reply");
  }
  if (window.MutationObserver) new MutationObserver(markLastReply).observe(messagesEl, { childList: true });
  input.addEventListener("input", function () { if (!input.value) editing = false; });

'''

CSS_COMMON = '''
/* message actions: reply / edit / try again */
.msg-actions .regen { display: none; }
.msg.last-reply .msg-actions .regen { display: inline-flex; }
'''

CSS_WEB = '''
.msg { position: relative; }
.msg-actions { position: absolute; display: flex; gap: 2px; opacity: 0; transition: opacity .15s; z-index: 2; }
.msg.assistant .msg-actions { top: -8px; right: 0; }
.msg.user .msg-actions { right: calc(100% + 4px); bottom: 4px; }
.msg:hover .msg-actions, .msg-actions:focus-within { opacity: 1; }
.msg:has(> .bubble:empty) .msg-actions { display: none; }
.msg-actions button { height: 24px; min-width: 24px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--dim); background: transparent; border: 0; cursor: pointer; }
.msg-actions button:hover { color: var(--hi); background: var(--acc-soft, rgba(255,255,255,.08)); }
.msg-actions button:focus-visible { outline: 2px solid var(--focus, #7b8cff); outline-offset: 1px; }
.msg-actions svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.msg-actions .done { color: var(--ok, #4ade80); }
'''

SEND_OLD = "var images = pics.slice(), files = docs.slice(), shown = text;"
SEND_NEW = (SEND_OLD + "\n    if (editing) { editing = false; if (text) { text = \"(edited) \" + text; shown = text; } }")

MARK = "  /* ---------- messages ---------- */\n"

# --- web (cyberpunk) ---
js = APP / "web" / "aura.js"
t = js.read_text(encoding="utf-8")
assert "function extraActions" not in t
assert t.count(MARK) == 1 and t.count(SEND_OLD) == 1
t = t.replace(MARK, HELP + MARK)
old = '''    wrap.appendChild(b);
    messagesEl.appendChild(wrap);
    scrollDown(role === "user");
    return b;'''
new = '''    wrap.appendChild(b);
    if (!kind) {
      var acts = document.createElement("div"); acts.className = "msg-actions";
      acts.appendChild(ownCopy(b)); extraActions(acts, b, role);
      wrap.appendChild(acts);
    }
    messagesEl.appendChild(wrap);
    scrollDown(role === "user");
    return b;'''
assert t.count(old) == 1
t = t.replace(old, new).replace(SEND_OLD, SEND_NEW)
js.write_text(t, encoding="utf-8")
css = APP / "web" / "aura.css"
c = css.read_text(encoding="utf-8")
assert ".msg-actions" not in c
css.write_text(c.rstrip("\n") + "\n" + CSS_WEB + CSS_COMMON, encoding="utf-8")

# --- hermes ---
js = APP / "web_hermes" / "aura.js"
t = js.read_text(encoding="utf-8")
assert "function extraActions" not in t
assert t.count(MARK) == 1 and t.count(SEND_OLD) == 1
t = t.replace(MARK, HELP + MARK)
old = '''      acts.appendChild(copyButton("act", "Copy message", "", function () { return b._raw != null ? b._raw : b.innerText; }));
      wrap.appendChild(acts);'''
new = '''      acts.appendChild(copyButton("act", "Copy message", "", function () { return b._raw != null ? b._raw : b.innerText; }));
      extraActions(acts, b, role);
      wrap.appendChild(acts);'''
assert t.count(old) == 1
t = t.replace(old, new).replace(SEND_OLD, SEND_NEW)
js.write_text(t, encoding="utf-8")
css = APP / "web_hermes" / "aura.css"
c = css.read_text(encoding="utf-8")
assert ".regen" not in c
css.write_text(c.rstrip("\n") + "\n" + CSS_COMMON, encoding="utf-8")
print("ok")
