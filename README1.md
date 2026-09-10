# האימוניה, Direction 06 design handoff

This package defines the approved Club Balance design for the complete app.

## Product rule

The workout tools are for post-workout management. Users record, edit, review, and manage completed workouts after training. Do not introduce live timers, rest counters, live coaching, or urgent in-session interaction.

## Visual direction

- Clean, calm, welcoming, and practical.
- Light and dark themes share identical layouts and hierarchy.
- Real club photography connects the digital product to the physical location.
- Photos support orientation and identity. Data and controls always sit on solid surfaces.
- Red and warm-white stripes are a signature accent. Keep them below 10 percent of the visible app area.
- Use warm cream, royal blue, deep navy, powder blue, coral red, and restrained steel tones.

## Recommended tokens

### Light

- Page background: `#F2F5FA`
- Warm background: `#F7F1E8`
- Surface: `#FFFFFF`
- Secondary surface: `#E9EFF8`
- Border: `#D6DFEC`
- Primary text: `#1C2536`
- Secondary text: `#57627A`
- Brand blue: `#2E5AA8`
- Coral accent: `#E85D3D`

### Dark

- Page background: `#152342`
- Surface: `#1F3057`
- Secondary surface: `#2A3D6B`
- Border: `#425481`
- Primary text: `#F2ECE1`
- Secondary text: `#A8B3C9`
- Brand blue: `#3E6FD9`
- Coral accent: `#E85D3D`

Check every foreground and background pair against WCAG AA. Use dark ink on coral fills where white does not reach the required contrast.

## Component system

- Card radius: 16 to 20 px.
- Control radius: 12 to 16 px.
- Touch targets: 44 px minimum.
- Horizontal page padding: 16 px on mobile.
- Section spacing: 16 to 24 px.
- Card spacing: 8 to 12 px.
- Use one primary action per page.
- Keep destructive actions separate and clearly labeled.
- Preserve RTL order and logical CSS properties.
- Keep bottom navigation stable across primary pages.
- Use photos in shallow 3:1 to 4:1 crops, usually below 16 percent of viewport height.
- Apply a navy overlay to photos in dark mode.

## Screen families

1. Record and edit workout.
2. Workout history.
3. Calendar and selected-day detail.
4. Progress and personal records.
5. Workout library and custom workout builder.
6. Community feed, announcements, and leaderboard preview.
7. Achievements and notifications.
8. Settings and onboarding.

## Photo mapping

- `club-stripe-wall-wide.jpeg`: recording, calendar, announcements.
- `club-stripe-wall-angle.jpeg`: recording details and exercise selection.
- `club-equipment-wide.jpeg`: workout history and workout library.
- `club-logo-wall-wide.jpeg`: community announcements and onboarding.
- `club-logo-wall-portrait.jpeg`: narrow mobile crops and promotional states.
- `club-rig-wide.jpeg`: progress, PRs, and open-space pages.
- `club-open-floor-wide.jpeg`: calendar and neutral outer backgrounds.
- `club-rings-portrait.jpeg`: achievements and progress.

## Mockups

- `00-direction-06-system.png`
- `01-record-edit.png`
- `02-history.png`
- `03-calendar.png`
- `04-progress-prs.png`
- `05-workout-library.png`
- `06-community.png`
- `07-achievements-notifications.png`
- `08-settings-onboarding.png`

Use `CLAUDE_CODE_PROMPT.md` as the implementation brief.
