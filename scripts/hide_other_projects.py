"""The admin screenshot runs on a shared local Zetaris that also hosts two unrelated projects' sources; cover those rows
in the Data Explorer list (not part of this entry) and say so on the image. Usage: python -I scripts/hide_other_projects.py <png>"""
import sys
from PIL import Image, ImageDraw
p = sys.argv[1]
im = Image.open(p).convert('RGB')
d = ImageDraw.Draw(im)
bg = im.getpixel((300, 470))
for y0, y1 in ((238, 306), (420, 452)):
    d.rectangle((282, y0, 530, y1), fill=bg)
d.text((310, 268), '(2 other local projects hidden)', fill=(140, 150, 170))
d.text((310, 430), '(1 other local project hidden)', fill=(140, 150, 170))
im.save(p)
