"""Start helper programs without a console window popping up (Windows).

Aura runs under pythonw.exe, which has no console. Any console program it starts (powershell, claude,
python, taskkill, pip...) would then get its OWN new console window that flashes open and shut.
hidden() gives such a child a hidden console instead; its own children inherit that hidden console,
so they stay invisible too. child_python() swaps pythonw.exe for python.exe: pythonw is a window-less
GUI program, so CREATE_NO_WINDOW does nothing for it and every program IT starts would flash again.
"""
import os
import subprocess
import sys

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def hidden() -> dict:
    """Keyword arguments for subprocess.run/Popen: hidden console, hidden window, no busy cursor."""
    if os.name != "nt":
        return {}
    opts = {"creationflags": NO_WINDOW}
    try:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW | 0x80  # 0x80 = STARTF_FORCEOFFFEEDBACK
        si.wShowWindow = 0  # SW_HIDE
        opts["startupinfo"] = si
    except Exception:
        pass
    return opts


def child_python() -> str:
    """The console python.exe next to the running interpreter (falls back to sys.executable)."""
    exe = sys.executable or "python"
    folder, name = os.path.split(exe)
    if name.lower() == "pythonw.exe":
        console = os.path.join(folder, "python.exe")
        if os.path.exists(console):
            return console
    return exe
