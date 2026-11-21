"""Qwen does things on the PC for you.  Usage:  python agent.py "download X to my Downloads folder" [--image PATH ...]

Qwen (through Ollama tool calling) can run PowerShell commands, open things, read and write files.
Safety rules (your rules): no deleting (only to the Recycle Bin), no Docker, no shutdown/format/registry/disk commands.
Everything is logged to logs/agent.log.

Inside the Aura app (env AURA_APP is set) the step lines are hidden, Aura's identity rules are added and
the open_website tool is offered only when the request is about browsing.
"""
import base64
import json
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

import requests

# Emojis/accents must never crash the output when it is piped (e.g. into the Aura app).
for _stream in (sys.stdout, sys.stderr):
    try:
        if not _stream.isatty():
            _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

def _ollama_url() -> str:
    try:
        f = Path(__file__).parent / "ollama_url.txt"
        if f.exists():
            u = f.read_text(encoding="utf-8-sig").strip()
            if u.lower().startswith(("http://", "https://")):
                return u
    except OSError:
        pass
    return os.environ.get("OLLAMA_URL", "http://localhost:11434")


ROOT = Path(__file__).parent
HOME = Path.home()
LOG = ROOT / "logs" / "agent.log"
IN_AURA = bool(os.environ.get("AURA_APP"))
OLLAMA_URL = _ollama_url()
NUM_CTX = int(os.environ.get("QWEN_NUM_CTX", "65536"))
MAX_STEPS = 15


def _model_name() -> str:
    if os.environ.get("AGENT_MODEL"):
        return os.environ["AGENT_MODEL"]
    try:
        return (ROOT / "model.txt").read_text(encoding="utf-8").strip() or "qwen3.8:27b"
    except OSError:
        return "qwen3.8:27b"


MODEL = _model_name()

sys.path.insert(0, str(ROOT / "src"))
try:
    from no_window import hidden as _hidden
except Exception:  # helper missing: plain behavior
    def _hidden():
        return {}
try:
    from browse_policy import wants_browser
except Exception:  # if the helper is missing, behave as before (browsing allowed)
    def wants_browser(text):
        return True
try:
    from think_policy import needs_thinking
except Exception:  # never let the helper stop the agent
    def needs_thinking(text, has_images=False):
        return False

BROWSE_OK = True  # set per task in main()

BLOCKED = re.compile(
    r"(remove-item|\brm\b|\bdel\b|\berase\b|\brmdir\b|\brd\b|\bdocker|clear-content|clear-disk|format-|"
    r"\bformat\b|stop-computer|restart-computer|\bshutdown\b|\bdiskpart\b|\breg(\.exe)?\s|"
    r"remove-|set-executionpolicy|\bcipher\b|\bicacls\b|\btakeown\b|\bnet\s+user\b|\bbcdedit\b|"
    r"out-file.*-force|set-content|\bmove-item\b|\bmv\b|\bren\b|rename-item)",
    re.I,
)
BROWSER_LAUNCH = re.compile(
    r"(start-process|\bstart\b|invoke-item|explorer(\.exe)?|msedge|chrome|firefox|opera|brave|iexplore)[^\n]*(https?://|www\.)",
    re.I,
)
ANOTHER_ANSWER = re.compile(
    r"\b(another (answer|one|way|version|reply)|different (answer|one|way|version|reply)|try again|"
    r"once more|again|something else|rephrase|reword|differently)\b"
)


def _tool(name, description, **params):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": {k: {"type": "string"} for k in params},
                       "required": list(params)}}}


TOOLS = [
    _tool("run_powershell",
          "Run one PowerShell command on the user's Windows PC and return its output. "
          "Use it to download files (Invoke-WebRequest, curl.exe, winget, ollama pull), "
          "install things, list files, open programs (Start-Process).", command=1),
    _tool("read_file", "Read a text file.", path=1),
    _tool("write_file", "Create a NEW text file (never overwrites an existing file outside the qwen-test folder).",
          path=1, content=1),
    _tool("delete_to_recycle_bin",
          "Delete a file or folder by moving it to the Windows Recycle Bin (can be restored). "
          "Use this for every delete request.", path=1),
]

SYSTEM = (
    "You are an assistant that DOES tasks on the user's Windows 11 PC using the tools. "
    "Do not ask questions and do not explain plans: act, check the result, fix errors, then finish "
    "with ONE short line saying what you did. Default download folder: " + str(HOME / "Downloads") + ". "
    "To delete, ONLY use the delete_to_recycle_bin tool. "
    "You may NOT use Docker or change system settings; if a task needs that, say so in one line."
)

AURA_RULES = " ".join((
    "IDENTITY: your name is Aura. You are Aura, a personal assistant app, built by Amar and Arry.",
    "Use the line \"I'm Aura, built by Amar & Arry.\" ONLY when the user directly asks who or what you are,",
    "what model or AI you are, or who made, built, trained or owns you, or which company is behind you.",
    "For EVERY other message, answer that message itself and never repeat the identity line.",
    "Never say or hint that you are Qwen, Alibaba, Alibaba Cloud, Tongyi or any other model or company.",
    "If the user asks whether you run locally or privately: in this mode you run on the user's own computer,",
    "so you can say yes, without naming any model or company.",
    "If the user asks for another answer, a different answer, to try again or to rephrase, give a NEW answer",
    "to their previous question in different words; never repeat your previous reply word for word.",
    "Answer plain questions directly and briefly (no tool needed).",
    "If anyone asks who Amar or Arry are, or asks anything about them, reply ONLY with a short cute line",
    "saying they are two lovebirds making something cute together (add a heart), with no other details about them.",
    "To open a website (for example YouTube) when the user ASKS to open or browse one, use the open_website tool",
    "with the full https:// address; never open a browser with commands.",
    "Open a website or search the web ONLY when the user explicitly asks to browse, open a site or look something up online.",
    "For 'show me', 'give me', 'tell me', 'make me' or any request for information, a recipe, a list or an answer,",
    "write the answer right in the chat and never open any page for it.",
))

if IN_AURA:
    SYSTEM += " " + AURA_RULES
    TOOLS.append(_tool(
        "open_website",
        "Open a web page (YouTube, Google, any website) or a local website file (full path to an .html file "
        "or its folder) inside the Aura app's own browser. ALWAYS use this to open a website. "
        "Never start a browser with run_powershell.", url=1))


def log(msg: str) -> None:
    try:
        LOG.parent.mkdir(exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except OSError:
        pass


# ---- opening websites inside Aura (through the app's local control door) ----
def _local_target(url: str):
    """A local file/folder path hidden in `url`, or None if it is a web address."""
    if url.lower().startswith("file:"):
        from urllib.parse import unquote, urlparse
        return unquote(urlparse(url).path).lstrip("/")
    if re.match(r"^[A-Za-z]:[\\/]", url):
        return url
    try:
        if url and not url.lower().startswith(("http://", "https://")) and Path(url).expanduser().exists():
            return url
    except OSError:
        pass
    return None


def open_in_aura(url: str) -> str:
    """Send a web address or a local website file to the Aura app's browser (it shows it in the pane)."""
    url = (url or "").strip().strip('"').strip("'")
    local = _local_target(url)
    params = {}
    if local:
        p = Path(local).expanduser()
        if p.is_dir():
            for name in ("index.html", "index.htm"):
                if (p / name).exists():
                    p = p / name
                    break
        if not p.is_file():
            return "That file was not found: " + str(p)
        params["path"] = shown = str(p)
    else:
        if not url.lower().startswith(("http://", "https://")):
            url = "https://" + url
        params["url"] = shown = url
    try:
        info = json.loads((ROOT / "logs" / "aura_ctl.json").read_text(encoding="utf-8"))
        params["token"] = info["token"]
        r = requests.get("http://127.0.0.1:%d/open" % int(info["port"]), params=params, timeout=5)
        if r.status_code == 200:
            return "Opened in the Aura browser: " + shown
    except Exception as exc:
        log("open_in_aura failed: " + repr(exc))
    import webbrowser
    webbrowser.open(Path(params["path"]).as_uri() if "path" in params else params["url"])
    return "The Aura browser was not available, so it was opened in the normal browser: " + shown


# ---- tools ----
def _run_powershell(cmd: str) -> str:
    if not BROWSE_OK and BROWSER_LAUNCH.search(cmd):
        return "REFUSED: the user did not ask to browse the web. Answer in the chat instead."
    if BLOCKED.search(cmd):
        return "REFUSED: this command can delete/change things and is not allowed."
    r = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True,
                       text=True, errors="replace", timeout=1800, cwd=str(HOME), **_hidden())
    return ((r.stdout or "") + (r.stderr or ""))[-3000:] or f"(done, exit code {r.returncode})"


def _write_file(path: str, content: str) -> str:
    p = Path(path)
    inside = ROOT.resolve() in p.resolve().parents
    if p.exists() and not inside:
        return "REFUSED: file already exists, not overwriting."
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"written: {p}"


def _delete_to_recycle_bin(path: str) -> str:
    p = Path(path).expanduser().resolve()
    if HOME.resolve() not in p.parents or p == ROOT.resolve() or ROOT.resolve() in p.parents:
        return "REFUSED: only files inside your user folder (not the qwen-test folder) can be deleted."
    if not p.exists():
        return f"ERROR: {p} does not exist."
    kind = "DeleteDirectory" if p.is_dir() else "DeleteFile"
    quoted = str(p).replace("'", "''")
    ps = ("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::"
          f"{kind}('{quoted}','OnlyErrorDialogs','SendToRecycleBin')")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True,
                       text=True, errors="replace", timeout=120, **_hidden())
    return f"moved to Recycle Bin: {p}" if r.returncode == 0 else f"ERROR: {(r.stderr or '')[-500:]}"


def run_tool(name: str, args: dict) -> str:
    try:
        if name == "open_website":
            return open_in_aura(str(args.get("url", "")))
        if name == "run_powershell":
            return _run_powershell(str(args.get("command", "")))
        if name == "read_file":
            return Path(args["path"]).read_text(encoding="utf-8", errors="replace")[:6000]
        if name == "write_file":
            return _write_file(args["path"], str(args.get("content", "")))
        if name == "delete_to_recycle_bin":
            return _delete_to_recycle_bin(args["path"])
        return f"unknown tool {name}"
    except subprocess.TimeoutExpired:
        return "ERROR: command took too long (30 min)."
    except Exception as e:  # report to Qwen so it can fix it
        return f"ERROR: {e}"


def load_images(paths: list[str]) -> list[str]:
    """Read picture files and return them base64-encoded (Qwen has vision)."""
    return [base64.b64encode(Path(p).read_bytes()).decode("ascii") for p in paths]


def _parse_args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except ValueError:
        return {}


def _chat(messages, tools, think: bool, vary: bool) -> dict:
    """One request to Ollama. Raises a clear error if Ollama cannot be reached."""
    options = {"temperature": 0.9 if vary else (0.6 if think else 0.1), "num_ctx": NUM_CTX}
    if vary:  # "another answer": a different seed so the reply really changes
        options["seed"] = random.randint(1, 2**31 - 1)
    try:
        r = requests.post(f"{OLLAMA_URL}/api/chat", timeout=900, json={
            "model": MODEL, "stream": False, "think": think, "tools": tools,
            "messages": messages, "options": options})
    except requests.exceptions.ConnectionError:
        sys.exit(f"Could not connect to Ollama at {OLLAMA_URL}. Is it running?")
    except requests.exceptions.Timeout:
        sys.exit("Ollama took too long to answer (15 min). Try again later.")
    if r.status_code >= 400:
        log(f"OLLAMA ERROR {r.status_code}: {r.text[:500]}")
        sys.exit(f"Ollama returned an error ({r.status_code}): {r.text[:300]}")
    return r.json().get("message") or {}


def main(task: str, images: list[str] | None = None) -> None:
    global BROWSE_OK
    user_msg = {"role": "user", "content": task}
    if images:
        user_msg["images"] = load_images(images)
    messages = [{"role": "system", "content": SYSTEM}, user_msg]
    log(f"TASK: {task}" + (f" [images: {', '.join(images)}]" if images else ""))

    think = bool(needs_thinking(task, bool(images)))  # slow "thinking" only when the request needs real reasoning
    request = task.split("New request from the user:")[-1].lower()
    vary = bool(ANOTHER_ANSWER.search(request))
    BROWSE_OK = bool(wants_browser(task))
    tools = TOOLS if BROWSE_OK else [t for t in TOOLS if t["function"]["name"] != "open_website"]
    log("THINK: " + ("on" if think else "off"))
    log("BROWSER: " + ("allowed" if BROWSE_OK else "not asked for"))

    for step in range(1, MAX_STEPS + 1):
        msg = _chat(messages, tools, think, vary)
        messages.append(msg)
        calls = msg.get("tool_calls") or []
        if not calls:
            final = (msg.get("content") or "").strip()
            print(final or "Done.")
            log(f"FINAL: {final}")
            return
        for call in calls:
            fn = call.get("function") or {}
            name = fn.get("name", "")
            args = _parse_args(fn.get("arguments"))
            if not IN_AURA:  # inside the Aura app the steps stay in logs/agent.log only
                print(f"[{step}] {name}: {json.dumps(args)[:200]}", flush=True)
            out = run_tool(name, args)
            log(f"{name} {json.dumps(args)[:300]} -> {out[:300]}")
            messages.append({"role": "tool", "tool_name": name, "content": out})
    print("Stopped: too many steps. See logs/agent.log.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit('Usage: python agent.py "what you want done" [--image PATH ...]')
    words, imgs, i = [], [], 1
    while i < len(sys.argv):
        if sys.argv[i] == "--image" and i + 1 < len(sys.argv):
            imgs.append(sys.argv[i + 1])
            i += 2
        else:
            words.append(sys.argv[i])
            i += 1
    missing = [p for p in imgs if not Path(p).is_file()]
    if missing:
        sys.exit(f"Picture not found: {missing[0]}")
    main(" ".join(words), imgs)
