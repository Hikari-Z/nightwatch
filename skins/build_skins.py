#!/usr/bin/env python3
"""Build themed skins from minimal's layout.

A theme (glass/, amber/, ...) keeps only what makes it itself: tokens before
the @@BASE@@ marker, overrides after it. This script splices minimal's layout
(everything from `* { box-sizing` on) into the marker and writes skin.css, so
a layout fix lands in every themed skin at once. Moonlamp (wacky/) is
hand-built and not themed from minimal.

Written by: claude-opus-5-5, 2026-10-05
"""
import os
HERE = os.path.dirname(os.path.abspath(__file__))
MARK = "/* @@BASE@@ (build_skins.py inserts minimal's layout here) */"

base = open(os.path.join(HERE, "minimal", "skin.css")).read()
base = base[base.index("* { box-sizing"):]
for d in sorted(os.listdir(HERE)):
    theme = os.path.join(HERE, d, "theme.css")
    if not os.path.isfile(theme):
        continue
    t = open(theme).read()
    assert MARK in t, f"{d}/theme.css has no base marker"
    out = t.replace(MARK, f"/* ---- minimal's layout (generated: edit minimal/skin.css, then run build_skins.py) ---- */\n{base}\n/* ---- {d} ---- */")
    open(os.path.join(HERE, d, "skin.css"), "w").write(out)
    print("built", d)
