#!/usr/bin/env python3
"""Print the title of every top-level window on $DISPLAY, one per line.

The Flatpak launch check reads the desktop app's windows with this: the
image it runs in has an X server but no xprop or xdotool. Stdlib and libX11
only. Titles come from `_NET_WM_NAME` (UTF-8), which GTK sets.
"""

import ctypes
import ctypes.util
import sys

x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XQueryTree.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint),
]
x11.XGetWindowProperty.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p),
]
x11.XFree.argtypes = [ctypes.c_void_p]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit("cannot open display")
root = x11.XDefaultRootWindow(display)
net_wm_name = x11.XInternAtom(display, b"_NET_WM_NAME", 0)
utf8_string = x11.XInternAtom(display, b"UTF8_STRING", 0)

root_return, parent_return = ctypes.c_ulong(), ctypes.c_ulong()
children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
x11.XQueryTree(display, root, ctypes.byref(root_return), ctypes.byref(parent_return), ctypes.byref(children), ctypes.byref(count))
for i in range(count.value):
    actual_type, actual_format = ctypes.c_ulong(), ctypes.c_int()
    items, remaining, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
    status = x11.XGetWindowProperty(
        display, children[i], net_wm_name, 0, 1024, 0, utf8_string,
        ctypes.byref(actual_type), ctypes.byref(actual_format), ctypes.byref(items), ctypes.byref(remaining), ctypes.byref(data),
    )
    if status == 0 and data.value and items.value:
        print(ctypes.string_at(data.value, items.value).decode("utf-8", "replace"))
    if data.value:
        x11.XFree(data)
if children:
    x11.XFree(children)
