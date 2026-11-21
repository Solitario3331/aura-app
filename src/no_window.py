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


DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def start_detached(cmd, cwd):
    """Start a window program that must outlive this one (Aura restarting itself): own process group,
    no console, not tied to our job object. Unlike hidden(), its window is NOT forced hidden."""
    io = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
          "close_fds": True, "cwd": cwd}
    if os.name != "nt":
        return subprocess.Popen(cmd, start_new_session=True, **io)
    base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        return subprocess.Popen(cmd, creationflags=base | CREATE_BREAKAWAY_FROM_JOB, **io)
    except OSError:  # our job object does not allow breakaway: plain detached is still fine
        return subprocess.Popen(cmd, creationflags=base, **io)


def gui_python() -> str:
    """The window-less pythonw.exe next to the running interpreter (falls back to sys.executable)."""
    exe = sys.executable or "pythonw"
    folder, name = os.path.split(exe)
    if name.lower() == "python.exe":
        gui = os.path.join(folder, "pythonw.exe")
        if os.path.exists(gui):
            return gui
    return exe


def child_python() -> str:
    """The console python.exe next to the running interpreter (falls back to sys.executable)."""
    exe = sys.executable or "python"
    folder, name = os.path.split(exe)
    if name.lower() == "pythonw.exe":
        console = os.path.join(folder, "python.exe")
        if os.path.exists(console):
            return console
    return exe
