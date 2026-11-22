"""web_hermes: the sidebar filter box is hidden now; its handler must not touch variables of another scope."""
from pathlib import Path

p = Path(__file__).parent / "web_hermes" / "aura.js"
t = p.read_text(encoding="utf-8")
old = ("    if (q && !showAllChats && sessions.length > RECENT) { showAllChats = true; renderSessions(); return; }\n"
       "    if (!q && showAllChats) { showAllChats = false; renderSessions(); return; }\n")
assert t.count(old) == 1
p.write_text(t.replace(old, ""), encoding="utf-8")
print("ok")
