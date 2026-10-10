"""Checks the Cinema 4D importer's logic outside Cinema 4D, against a minimal stand-in for the
`c4d` module:  python tools/c4d-plugin-check.py
Reads the latest "Export to Cinema 4D" handoff, runs the plugin's own import code on it and checks
counts, index ranges, face orientation and that every texture is a single-IDAT PNG.
It cannot prove Cinema 4D's own behaviour - only that the plugin feeds it consistent data.
"""
import json
import os
import struct
import sys
import types


class Vector:
    __slots__ = ('x', 'y', 'z')

    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = x, y, z

    def __sub__(self, o):
        return Vector(self.x - o.x, self.y - o.y, self.z - o.z)

    def cross(self, o):
        return Vector(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x)


class CPolygon:
    def __init__(self, a, b, c, d):
        self.a, self.b, self.c, self.d = a, b, c, d


class Node(dict):
    def __init__(self, kind=None):
        super().__init__()
        self.kind, self.name, self.tags, self.children, self.shaders = kind, '', [], [], []

    def SetName(self, n): self.name = n
    def InsertTag(self, t): self.tags.append(t)
    def InsertShader(self, s): self.shaders.append(s)
    def Message(self, m): return True


class PolygonObject(Node):
    def __init__(self, points, polys):
        super().__init__('poly')
        self.points, self.polys = [None] * points, [None] * polys

    def SetAllPoints(self, pts):
        assert len(pts) == len(self.points), 'point count mismatch'
        self.points = pts

    def SetPolygon(self, i, p): self.polys[i] = p


class UVWTag(Node):
    def __init__(self, n):
        super().__init__('uvw')
        self.uv = [None] * n

    def SetSlow(self, i, a, b, c, d): self.uv[i] = (a, b, c, d)


class Doc:
    def __init__(self): self.objects, self.materials = [], []
    def InsertObject(self, o, parent=None, pred=None): (parent.children if parent is not None else self.objects).append(o)
    def InsertMaterial(self, m): self.materials.append(m)
    def AddUndo(self, *a): pass


c4d = types.ModuleType('c4d')
c4d.Vector, c4d.CPolygon, c4d.PolygonObject, c4d.UVWTag = Vector, CPolygon, PolygonObject, UVWTag
c4d.BaseMaterial = c4d.BaseShader = c4d.BaseObject = lambda kind=None: Node(kind)
c4d.TextureTag = lambda: Node('texture')
for i, n in enumerate(['Mmaterial', 'Xbitmap', 'Onull', 'MATERIAL_USE_COLOR', 'BITMAPSHADER_FILENAME', 'BITMAPSHADER_INTERPOLATION',
                       'BITMAPSHADER_INTERPOLATION_NONE', 'MATERIAL_COLOR_SHADER', 'MATERIAL_USE_ALPHA', 'MATERIAL_ALPHA_SHADER',
                       'MATERIAL_ALPHA_IMAGEALPHA', 'MATERIAL_ALPHA_INVERT', 'MATERIAL_ALPHA_SOFT', 'MATERIAL_USE_REFLECTION',
                       'BITMAPSHADER_TIMING_MODE', 'BITMAPSHADER_TIMING_MODE_LOOP', 'BITMAPSHADER_TIMING_TIMING',
                       'BITMAPSHADER_TIMING_TIMING_FRAME', 'BITMAPSHADER_TIMING_FROM', 'BITMAPSHADER_TIMING_TO',
                       'BITMAPSHADER_TIMING_FPS', 'MATERIAL_ANIMATEPREVIEW',
                       'MSG_UPDATE', 'UNDOTYPE_NEW', 'TEXTURETAG_MATERIAL', 'TEXTURETAG_PROJECTION', 'TEXTURETAG_PROJECTION_UVW', 'CMD_ENABLED']):
    setattr(c4d, n, 1000 + i)
c4d.StatusSetText = c4d.StatusSetBar = lambda *a: None
c4d.StatusClear = lambda: None
c4d.plugins = types.SimpleNamespace(CommandData=object, RegisterCommandPlugin=lambda *a: True)
c4d.gui = types.SimpleNamespace(MessageDialog=print)
sys.modules['c4d'] = c4d

here = os.path.dirname(os.path.abspath(__file__))
plugin = os.path.join(here, '..', 'c4d-plugin', 'BedrockWorldImporter.pyp')
ns = {'__name__': 'bedrock_world_importer'}
with open(plugin, 'r', encoding='utf-8') as f:
    exec(compile(f.read(), plugin, 'exec'), ns)

with open(ns['get_handoff_path'](), 'r', encoding='utf-8') as f:
    handoff = json.load(f)
doc = Doc()
parent, total = ns['import_world'](doc, handoff)

problems = []
objs = parent.children
up = down = other = 0
bad_index = bad_uv = 0
for o in objs:
    uv = next(t for t in o.tags if t.kind == 'uvw')
    if not any(t.kind == 'texture' for t in o.tags):
        problems.append('no texture tag on ' + o.name)
    for i, p in enumerate(o.polys):
        if max(p.a, p.b, p.c, p.d) >= len(o.points):
            bad_index += 1
            continue
        if uv.uv[i] is None:
            bad_uv += 1
        if o.name.startswith('grass_top'):
            a, b, c_, d = (o.points[k] for k in (p.a, p.b, p.c, p.d))
            n = (a - c_).cross(b - d)  # Cinema 4D's face normal
            if n.y > 0 and abs(n.x) < 1e-6 and abs(n.z) < 1e-6:
                up += 1
            elif n.y < 0:
                down += 1
            else:
                other += 1

def idat_chunks(path):
    with open(path, 'rb') as f:
        data = f.read()
    pos, idat = 8, 0
    while pos + 8 <= len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        idat += kind == b'IDAT'
        pos += 12 + length
    return idat


multi_idat = []
animated = []
by_name = {m.name: m for m in doc.materials}
for g in handoff['groups']:
    files = [g['texture']]
    frames = int(g.get('frames') or 1)
    if frames > 1:
        # every frame of the sequence must exist next to frame 0, numbered without gaps
        folder, first = os.path.split(g['texture'])
        stem = first[:-len('_0000.png')]
        files = [os.path.join(folder, '%s_%04d.png' % (stem, i)) for i in range(frames)]
        missing = [p for p in files if not os.path.exists(p)]
        if missing:
            problems.append('%s: %d of %d frames missing' % (g['name'], len(missing), frames))
            files = [p for p in files if os.path.exists(p)]
        shader = by_name[g['name']].shaders[0]
        if shader.get(c4d.BITMAPSHADER_TIMING_TO) != frames - 1 or shader.get(c4d.BITMAPSHADER_TIMING_MODE) != c4d.BITMAPSHADER_TIMING_MODE_LOOP:
            problems.append('%s: sequence timing not set' % g['name'])
        if not by_name[g['name']].get(c4d.MATERIAL_ANIMATEPREVIEW):
            problems.append('%s: animate preview not set' % g['name'])
        animated.append('%s (%d frames @ %g fps)' % (g['name'], frames, g.get('fps')))
    for p in files:
        if idat_chunks(p) != 1:
            multi_idat.append(os.path.basename(p))

alpha = sum(1 for m in doc.materials if c4d.MATERIAL_USE_ALPHA in m)
result = {
    'objects': len(objs), 'materials': len(doc.materials), 'materialsWithAlpha': alpha,
    'polygons': sum(len(o.polys) for o in objs), 'expected': sum(g['quads'] for g in handoff['groups']), 'reported': total,
    'badIndices': bad_index, 'missingUVs': bad_uv, 'grassTopNormals': {'up': up, 'down': down, 'other': other},
    'texturesNotSingleIDAT': multi_idat, 'animated': animated, 'problems': problems,
}
print(json.dumps(result))
ok = (not problems and not bad_index and not bad_uv and not multi_idat and down == 0 and other == 0
      and result['polygons'] == result['expected'] == total)
sys.exit(0 if ok else 1)
