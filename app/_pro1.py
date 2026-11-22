JS = '''  function choiceBlock(options) {
    var wrap = document.createElement("div"); wrap.className = "choices";
    options.forEach(function (o) {
      var b = document.createElement("button"); b.type = "button"; b.className = "choice"; b.textContent = o;
      b.addEventListener("click", function () {
        if (wrap.classList.contains("done") || busy) return;
        wrap.classList.add("done"); b.classList.add("picked");
        input.value = o; input.dispatchEvent(new Event("input")); send();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }
'''
CSS = '''
/* choice cards (tap an option = it is sent as your reply) */
.choices { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 4px; }
.choice { text-align: left; font: inherit; font-size: var(--fs-sm); color: var(--text); background: var(--hover);
  border: 1px solid var(--line2); border-radius: var(--r-lg, 8px); padding: 9px 13px; cursor: pointer; transition: border-color var(--dur), background var(--dur); }
.choice:hover { border-color: var(--acc); background: var(--acc-soft); }
.choices.done .choice { opacity: .45; cursor: default; pointer-events: none; }
.choices.done .choice.picked { opacity: 1; border-color: var(--acc); background: var(--acc-soft); }
'''
BS = chr(92)
old = '        out.appendChild(codeBlock(code.join("' + BS + 'n"), m[1]));'
new = ('        if (m[1] === "choices") { var opts = code.map(function (x) { return x.trim(); }).filter(Boolean);\n'
       '          if (opts.length) { out.appendChild(choiceBlock(opts)); continue; } }\n' + old)
for d in ("app/web", "app/web_hermes"):
    p = d + "/aura.js"
    s = open(p, encoding="utf-8").read()
    assert old in s, d
    s = s.replace("  function renderRich(el, text) {", JS + "  function renderRich(el, text) {", 1)
    s = s.replace(old, new, 1)
    open(p, "w", encoding="utf-8").write(s)
    c = open(d + "/aura.css", encoding="utf-8").read()
    open(d + "/aura.css", "w", encoding="utf-8").write(c.rstrip("\n") + "\n" + CSS)
print("ok")
