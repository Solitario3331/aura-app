"""Start page: bring back the typing line, and make everything smaller and neater (both looks)."""
from pathlib import Path

APP = Path(__file__).parent

CSS_WEB = '''
/* start page, compact and neat: AURA, typing line, one-line greeting, a smaller box, small idea buttons */
#main.is-empty #messages:empty::before { font-size: 22px; text-shadow: 0 0 26px rgba(71,71,255,.35); }
#main.is-empty #messages:empty::after { display: block; margin: 12px auto 0; }
#main.is-empty #startGreet { margin: 16px 0 22px; }
#startGreet h1, #startGreet p { display: inline; font-family: var(--sans); font-size: 16px; line-height: 1.4; letter-spacing: 0; }
#startGreet h1 { font-weight: 500; color: var(--hi); }
#startGreet h1::after { content: "."; }
#startGreet p { margin: 0 0 0 .35em; color: var(--mute); }
#main.is-empty #composer { min-height: 76px; padding: 11px 10px 10px 16px; box-shadow: 0 16px 44px -22px rgba(71,71,255,.4), inset 0 0 0 1px rgba(255,255,255,.02); }
#main.is-empty #input { min-height: 38px; font-size: 15px; }
#main.is-empty .mode-row { margin-bottom: 8px; }
#main.is-empty #startChips { margin-top: 16px; gap: 8px; }
.start-chip { height: 28px; padding: 0 12px; gap: 7px; font-size: 10.5px; }
.start-chip svg { width: 13px; height: 13px; }
'''

CSS_HERMES = '''
/* start page, compact and neat */
#main.is-empty .wl-wordmark { font-size: clamp(40px, 6vw, 64px); margin-bottom: 14px; }
.wl-title { gap: 4px; }
.wl-hi { font-size: 20px; }
.wl-sub { font-size: 14px; }
#main.is-empty #messages:empty:not(.loading) + #welcome { padding-bottom: 18px; }
#main.is-empty #composer { padding: 12px 12px 10px 16px; }
#main.is-empty #input { min-height: 40px; font-size: 15px; }
#main.is-empty #startChips { margin-top: 16px; gap: 8px; }
.start-chip { height: 30px; padding: 0 12px; font-size: 12.5px; }
.start-chip svg { width: 14px; height: 14px; }
'''

for ui, css_new in (("web", CSS_WEB), ("web_hermes", CSS_HERMES)):
    p = APP / ui / "aura.css"
    c = p.read_text(encoding="utf-8")
    assert "compact and neat" not in c
    p.write_text(c.rstrip("\n") + "\n" + css_new, encoding="utf-8")
print("ok")
