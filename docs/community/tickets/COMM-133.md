# COMM-133 PR share prompt UI

Phase: 1
Agent: achievements
Status: todo
Attendance-blocked: no

## User outcome

After a PR, the member gets a simple choice to celebrate it with the club or
not, with no pressure.

## Acceptance criteria

- [ ] On PR_CREATED, a dialog shows the movement, the new result, and the
  improvement, with actions Share, Add photo, Add note, Not now.
- [ ] Nothing is posted unless the member picks Share or Add photo or Add
  note.
- [ ] Not now dismisses and does not prompt again for that record.
- [ ] Add photo routes through `prepareImage` from COMM-015.
- [ ] The dialog is focus trapped, Escape maps to Not now, focus returns to
  the prior control.
- [ ] Share hands off to the POST_PR create path in COMM-105.

## Frontend states

- Prompt: the four actions.
- Loading: Share shows a spinner.
- Error: "Could not share. Try again." with the prompt kept.
- Dismissed: no trace, no post.

## Client calls and contracts

- Consumes PR_CREATED.
- Calls the POST_PR create path from COMM-105.

## Validation rules and limits

- Note max 1000 characters.

## Migration outline

- None.

## Dependencies

- COMM-015, COMM-105, COMM-132.
