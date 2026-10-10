"""Bedrock World Importer - a small Cinema 4D command plugin.

Builds whatever Bedrock OBJ Exporter last sent with "Export to Cinema 4D" as
real polygon objects with matching materials in the current document.

INSTALL
  Bedrock OBJ Exporter copies this file into your Cinema 4D "plugins" folder
  the first time you use "Export to Cinema 4D". Restart Cinema 4D once after
  that. (By hand: Edit > Preferences, the button in the bottom-left corner
  opens the user folder; put this file in its "plugins" folder.)

USE
  In Bedrock OBJ Exporter select an area and click "Export to Cinema 4D".
  Then in Cinema 4D run Extensions > Import Bedrock World.

WHAT YOU GET
  - One Null named after the world, with one polygon object per texture
    under it. The Null sits at the centre of the selection, at its bottom.
  - 1 block = 100 cm (times the app's Scale), the same scale Essential
    Cosmetic Studio's importer uses, so cosmetics and worlds line up.
  - Real quads with UVs, textures sampled without smoothing (crisp pixels),
    alpha set up for cutout / see-through textures.
  - Animated textures (water, lava, fire, lanterns, sea lanterns, kelp...)
    come in as looping image sequences at the game's speed. Press play.
  - Cinema 4D is left-handed where Minecraft is right-handed, so Z is flipped
    and the winding reversed on the way in: nothing comes in mirrored and
    normals face outwards. North (Minecraft -Z) points along Cinema 4D +Z.

  Running the command again adds a fresh copy of the latest export next to
  anything already in the document.
"""

import array
import json
import os
import sys

import c4d

# Unregistered/private plugin ID - fine for a personal, non-distributed plugin.
PLUGIN_ID = 1067421


def get_documents_folder():
    """The user's real Documents folder (Windows often relocates it, e.g. into OneDrive)."""
    if sys.platform == 'win32':
        try:
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
            ) as key:
                value, _ = winreg.QueryValueEx(key, 'Personal')
                expanded = os.path.expandvars(value)
                if expanded:
                    return expanded
        except OSError:
            pass
    return os.path.join(os.path.expanduser('~'), 'Documents')


def get_handoff_path():
    return os.path.join(get_documents_folder(), 'BedrockObjExporter', 'c4d-export', 'handoff.json')


def set_no_interpolation(shader):
    # Blocky textures: Cinema 4D's default mip-mapped sampling blurs the pixel edges.
    try:
        shader[c4d.BITMAPSHADER_INTERPOLATION] = c4d.BITMAPSHADER_INTERPOLATION_NONE
    except AttributeError:
        pass


def configure_shader_for_sequence(shader, frame_count, fps):
    """`shader` points at frame 0 of a numbered PNG sequence (name_0000.png, name_0001.png, ...),
    which Cinema 4D's bitmap loader recognises as an image sequence. Make it loop over exactly
    those frames at the speed the game plays them (water, lava, fire, lanterns...)."""
    try:
        shader[c4d.BITMAPSHADER_TIMING_MODE] = c4d.BITMAPSHADER_TIMING_MODE_LOOP
        shader[c4d.BITMAPSHADER_TIMING_TIMING] = c4d.BITMAPSHADER_TIMING_TIMING_FRAME
        shader[c4d.BITMAPSHADER_TIMING_FROM] = 0
        shader[c4d.BITMAPSHADER_TIMING_TO] = frame_count - 1
        shader[c4d.BITMAPSHADER_TIMING_FPS] = float(fps)
    except AttributeError:
        pass


def build_material(group):
    texture_path = group['texture']
    frames = int(group.get('frames') or 1)
    fps = float(group.get('fps') or 20.0)
    mat = c4d.BaseMaterial(c4d.Mmaterial)
    mat.SetName(group.get('name') or 'Bedrock')

    mat[c4d.MATERIAL_USE_COLOR] = True
    color_shader = c4d.BaseShader(c4d.Xbitmap)
    color_shader[c4d.BITMAPSHADER_FILENAME] = texture_path
    set_no_interpolation(color_shader)
    if frames > 1:
        configure_shader_for_sequence(color_shader, frames, fps)
    mat.InsertShader(color_shader)
    mat[c4d.MATERIAL_COLOR_SHADER] = color_shader

    # Alpha only where the texture actually has holes or is see-through (leaves, plants, glass,
    # water); solid blocks stay plain so they render fast and never pick up edge artefacts.
    if group.get('mode') != 'opaque':
        mat[c4d.MATERIAL_USE_ALPHA] = True
        alpha_shader = c4d.BaseShader(c4d.Xbitmap)
        alpha_shader[c4d.BITMAPSHADER_FILENAME] = texture_path
        set_no_interpolation(alpha_shader)
        if frames > 1:
            configure_shader_for_sequence(alpha_shader, frames, fps)
        mat.InsertShader(alpha_shader)
        mat[c4d.MATERIAL_ALPHA_SHADER] = alpha_shader
        for name, value in (('MATERIAL_ALPHA_IMAGEALPHA', True), ('MATERIAL_ALPHA_INVERT', False),
                            ('MATERIAL_ALPHA_SOFT', group.get('mode') == 'blend')):
            try:
                mat[getattr(c4d, name)] = value
            except AttributeError:
                pass

    # Matte, like the game.
    for flag in ('MATERIAL_USE_REFLECTION', 'MATERIAL_USE_SPECULAR'):
        try:
            mat[getattr(c4d, flag)] = False
        except AttributeError:
            pass

    # "Animate Preview": without it an animated texture sits on frame 0 in the viewport.
    if frames > 1:
        try:
            mat[c4d.MATERIAL_ANIMATEPREVIEW] = True
        except AttributeError:
            pass

    mat.Message(c4d.MSG_UPDATE)
    return mat


def read_group(f, group):
    """Returns (points, quads, uvs) as flat arrays for one material group of world.bin."""
    n_points, n_quads = int(group['points']), int(group['quads'])
    f.seek(int(group['offset']))
    points = array.array('f')
    points.frombytes(f.read(n_points * 12))
    index_type = 'I' if array.array('I').itemsize == 4 else 'L'
    quads = array.array(index_type)
    quads.frombytes(f.read(n_quads * 16))
    uvs = array.array('f')
    uvs.frombytes(f.read(n_quads * 32))
    if sys.byteorder != 'little':
        points.byteswap()
        quads.byteswap()
        uvs.byteswap()
    if len(points) != n_points * 3 or len(quads) != n_quads * 4 or len(uvs) != n_quads * 8:
        raise ValueError('world.bin is shorter than handoff.json says - export again.')
    return points, quads, uvs


def build_object(group, points, quads, uvs, unit):
    n_quads = len(quads) // 4
    obj = c4d.PolygonObject(len(points) // 3, n_quads)
    obj.SetName(group.get('name') or 'Bedrock')

    # Minecraft is right-handed, Cinema 4D left-handed: flip Z, and reverse each quad's winding
    # (below) so the faces still point outwards.
    Vector = c4d.Vector
    obj.SetAllPoints([Vector(points[i] * unit, points[i + 1] * unit, -points[i + 2] * unit)
                      for i in range(0, len(points), 3)])

    CPolygon = c4d.CPolygon
    set_polygon = obj.SetPolygon
    for q in range(n_quads):
        b = q * 4
        set_polygon(q, CPolygon(quads[b], quads[b + 3], quads[b + 2], quads[b + 1]))

    # UVs arrive with v = 0 at the top of the image, which is also Cinema 4D's convention.
    uvw = c4d.UVWTag(n_quads)
    set_uv = uvw.SetSlow
    for q in range(n_quads):
        o = q * 8
        set_uv(q, Vector(uvs[o], uvs[o + 1], 0), Vector(uvs[o + 6], uvs[o + 7], 0),
               Vector(uvs[o + 4], uvs[o + 5], 0), Vector(uvs[o + 2], uvs[o + 3], 0))
    obj.InsertTag(uvw)
    obj.Message(c4d.MSG_UPDATE)
    return obj


def import_world(doc, handoff):
    """Builds the export described by `handoff` into `doc`. Returns (null object, quad count)."""
    groups = handoff.get('groups') or []
    unit = float(handoff.get('unitCm') or 100.0)

    parent = c4d.BaseObject(c4d.Onull)
    parent.SetName(handoff.get('name') or 'Bedrock World')
    doc.InsertObject(parent)
    doc.AddUndo(c4d.UNDOTYPE_NEW, parent)

    total = 0
    last = None
    with open(handoff['meshPath'], 'rb') as f:
        for i, group in enumerate(groups):
            c4d.StatusSetText('Importing Bedrock world: {}'.format(group.get('name')))
            c4d.StatusSetBar(int(100.0 * i / max(1, len(groups))))
            if not int(group.get('quads') or 0) or not os.path.exists(group.get('texture') or ''):
                continue
            points, quads, uvs = read_group(f, group)

            mat = build_material(group)
            doc.InsertMaterial(mat)
            doc.AddUndo(c4d.UNDOTYPE_NEW, mat)

            obj = build_object(group, points, quads, uvs, unit)
            tag = c4d.TextureTag()
            tag[c4d.TEXTURETAG_MATERIAL] = mat
            tag[c4d.TEXTURETAG_PROJECTION] = c4d.TEXTURETAG_PROJECTION_UVW
            obj.InsertTag(tag)
            # Keep creation order (same as the app's material order) in the Object Manager.
            doc.InsertObject(obj, parent=parent, pred=last)
            doc.AddUndo(c4d.UNDOTYPE_NEW, obj)
            last = obj
            total += len(quads) // 4
    return parent, total


class ImportBedrockWorldCommand(c4d.plugins.CommandData):
    def Execute(self, doc):
        handoff_path = get_handoff_path()
        if not os.path.exists(handoff_path):
            c4d.gui.MessageDialog(
                'No export found.\n\n'
                'In Bedrock OBJ Exporter, select an area and click '
                '"Export to Cinema 4D" first, then run this command again.'
            )
            return True
        try:
            with open(handoff_path, 'r', encoding='utf-8') as f:
                handoff = json.load(f)
            if not os.path.exists(handoff.get('meshPath') or ''):
                raise FileNotFoundError(handoff.get('meshPath'))
        except Exception as e:
            c4d.gui.MessageDialog('Could not read the exported files:\n\n{}'.format(e))
            return True

        doc.StartUndo()
        try:
            parent, total = import_world(doc, handoff)
        except Exception as e:
            doc.EndUndo()
            c4d.StatusClear()
            c4d.gui.MessageDialog('Import failed:\n\n{}'.format(e))
            return True
        doc.EndUndo()
        c4d.StatusClear()
        if total == 0:
            c4d.gui.MessageDialog('The export has nothing to import.')
            return True
        doc.SetActiveObject(parent)
        c4d.EventAdd()
        return True

    def GetState(self, doc):
        return c4d.CMD_ENABLED


if __name__ == '__main__':
    c4d.plugins.RegisterCommandPlugin(
        PLUGIN_ID,
        'Import Bedrock World',
        0,
        None,
        'Imports the area last sent from Bedrock OBJ Exporter',
        ImportBedrockWorldCommand()
    )
