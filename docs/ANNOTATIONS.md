# Slide annotations and laser pointer

In the editor, draw directly on the slide with a stylus. DeckWerk automatically
selects the freehand Pencil tool. For a mouse or trackpad, choose **Pen ▾ →
Pencil** or press **Shift+P**. Press **Escape** to return to selecting objects.
Each stroke is an ordinary vector shape: select it to change its stroke colour
or width, move it, or delete it. Undo removes one stroke at a time.

During a presentation, use the **Navigate**, **Pen**, and **Laser** controls at
the bottom of the audience view:

- **Pen** (**P**) draws freehand with the mouse or stylus. A stylus also draws
  directly while Navigate is selected. Completed strokes are saved to the
  current slide automatically, and can be edited afterwards in the editor.
  Presentation ink starts red, with a width of four slide pixels.
- **Laser** (**L**) displays a red pointer. Moving or clicking with it does not
  advance the slide. Holding **Ctrl** while pointing also activates a temporary
  laser; releasing Ctrl hides it.
- **Navigate** (**V**) returns to normal slide navigation. Escape puts an active
  tool down; in browser fullscreen, the browser may handle Escape first. Arrow
  keys continue to navigate while a tool is selected.

These controls work in the desktop audience window and browser presentations.
Draw on the audience view; Speaker View remains the notes and navigation view.
Palm contacts are ignored during a stroke, and a cancelled stroke is discarded.

Use the existing **Export PDF** command to include saved annotations. Ink uses
the same vector renderer as other shapes and appears in initial, final, and
every-build PDF exports. The laser and presentation controls are temporary and
are never saved to the deck or included in a PDF.
