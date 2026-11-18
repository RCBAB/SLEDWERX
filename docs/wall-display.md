# Garage Board Wall Display

Open `/garage/board?display=wall` on the garage screen (or choose **Wall
display** on the Garage Board). It fills the window with large touch
targets, refreshes every 5 minutes and when the screen wakes, and keeps the
screen on where the browser allows it.

## On-screen keyboard

The SledWerx keyboard appears only in Wall Display, when **Keyboard: On**
(the default; the choice is saved with your account).

- Mileage, engine hours and money fields get a large number pad (with a
  decimal point where decimals are allowed). Notes and other text fields get
  a full keyboard with Shift (tap twice for caps lock), Space, Backspace,
  numbers and punctuation.
- Keys never move focus or submit the form; **Save** does. **Done** (or Esc)
  closes the keyboard; Esc again closes the dialog.
- Dialogs shrink above the keyboard, so the field, its message and the Save
  row stay visible.
- A physical keyboard always works. Typing on it hides the on-screen
  keyboard until a field is tapped again.
- Date fields keep the browser's own date picker.

## Windows touchscreens

Windows can open its own touch keyboard when a field is tapped (in tablet
mode, or with "Show the touch keyboard when there's no keyboard attached").
While the SledWerx keyboard is showing, the field is marked
`inputmode="none"`, which Microsoft Edge and Google Chrome respect, so the
Windows keyboard stays closed. With the SledWerx keyboard off, Windows
behaves normally.

Recommended set-up for a wall PC:

- Use Microsoft Edge or Google Chrome (Firefox honours `inputmode="none"`
  less reliably), ideally in full screen (F11) or kiosk mode.
- The Windows keyboard can still be opened by hand from the taskbar; it
  types into the same field and does not conflict.
