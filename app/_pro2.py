JS = '''  /* ---------- thinking switch (Off / Low / Medium / High) ---------- */
  var THINK_STEPS = ["off", "low", "medium", "high"], thinkLevel = "medium";
  try { var tl0 = localStorage.getItem("auraThink"); if (THINK_STEPS.indexOf(tl0) >= 0) thinkLevel = tl0; } catch (e) {}
  function paintThink() {
    var b = $("thinkBtn"); if (!b) return;
    var locked = mode === "auto" || mode === "polish";
    var lv = mode === "auto" ? "off" : mode === "polish" ? "high" : thinkLevel;
    b.textContent = "Thinking: " + lv.charAt(0).toUpperCase() + lv.slice(1);
    b.classList.toggle("on", lv !== "off");
    b.disabled = locked;
    b.title = mode === "auto" ? "Quick never thinks" : mode === "polish" ? "Polish always thinks" : "Click to change how much Aura thinks";
  }
  function pushThink() { try { if (api && api.set_think) api.set_think(thinkLevel); } catch (e) {} }
  (function initThink() {
    var b = $("thinkBtn"); if (!b) return;
    b.addEventListener("click", function () {
      thinkLevel = THINK_STEPS[(THINK_STEPS.indexOf(thinkLevel) + 1) % THINK_STEPS.length];
      try { localStorage.setItem("auraThink", thinkLevel); } catch (e) {}
      paintThink(); pushThink();
    });
    paintThink();
  })();
'''
CSS = '''
/* thinking switch */
#thinkBtn { font: inherit; font-size: var(--fs-xs); color: var(--dim); background: transparent; border: 1px solid var(--line2);
  border-radius: 999px; padding: 4px 11px; cursor: pointer; white-space: nowrap; transition: color var(--dur), border-color var(--dur); }
#thinkBtn.on { color: var(--acc); border-color: var(--acc); }
#thinkBtn:hover:not(:disabled) { color: var(--hi); }
#thinkBtn:disabled { opacity: .55; cursor: default; }
'''
BTN = '<button id="thinkBtn" type="button" title="Thinking" aria-label="Thinking level">Thinking: Medium</button>'
cfg = {
    "app/web": ('<div id="pills" role="group" aria-label="Mode"></div></div>',
                '<div id="pills" role="group" aria-label="Mode"></div>' + BTN + '</div>'),
    "app/web_hermes": ('          <span class="cmp-fill"></span>',
                       '          ' + BTN + '\n          <span class="cmp-fill"></span>'),
}
for d, (old, new) in cfg.items():
    h = open(d + "/index.html", encoding="utf-8").read()
    assert h.count(old) == 1, d
    open(d + "/index.html", "w", encoding="utf-8").write(h.replace(old, new))
    s = open(d + "/aura.js", encoding="utf-8").read()
    a1 = "  function startWork(sid, m, text, images) {"
    a2 = "mode = m.id;"
    assert s.count(a1) == 1 and s.count(a2) == 1, d
    s = s.replace(a1, a1 + "\n    pushThink();")
    s = s.replace(a2, a2 + " paintThink();")
    # define the block before the first use site (function declarations hoist; the IIFE needs $ and mode)
    anchor = "  function buildPills() {"
    assert s.count(anchor) == 1, d
    s = s.replace(anchor, JS + "\n" + anchor)
    open(d + "/aura.js", "w", encoding="utf-8").write(s)
    c = open(d + "/aura.css", encoding="utf-8").read()
    open(d + "/aura.css", "w", encoding="utf-8").write(c.rstrip("\n") + "\n" + CSS)
print("ok")
