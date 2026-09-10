# Claude Code implementation prompt

You are redesigning the existing האימוניה PWA using the approved Direction 06 Club Balance system.

First, read the full repository, including any `CLAUDE.md`, `AGENTS.md`, audit documents, tests, migrations, service worker, manifest, and accessibility checks. Inspect the current UI structure and behavior before editing anything.

Reference files are in this handoff package:

- `README.md`, authoritative design rules and screen mapping.
- `mockups/`, approved visual targets.
- `photos/`, curated photos from the real club.

## Non-negotiable product rules

1. The workout tools support post-workout management only. Do not add live workout timers, rest counters, live coaching, or urgent in-session behavior.
2. Preserve all existing application behavior, data structures, permissions, offline support, sync behavior, security controls, accessibility behavior, and tests unless a visual change strictly requires a compatible markup adjustment.
3. Do not alter Supabase schemas, migrations, RLS policies, Edge Functions, authentication, or business logic for this design task.
4. Do not remove or rename existing IDs, data-action attributes, event hooks, ARIA relationships, or test selectors without updating every dependent reference and proving compatibility.
5. Keep the app fully RTL in Hebrew. Use logical CSS properties.
6. Maintain WCAG AA contrast, keyboard support, focus visibility, zoom, reduced-motion behavior, 44 px touch targets, safe areas, and screen-reader semantics.
7. Maintain PWA behavior, offline asset caching, CSP compatibility, self-hosted fonts, and zero unnecessary third-party requests.
8. Preserve responsive behavior for mobile and desktop.

## Approved design system

Implement the colors, spacing, components, photo rules, and page mapping from `README.md`. Reuse the current CSS token architecture where possible. Do not create duplicate theme systems.

Light theme:

- Warm cream and pale blue page surfaces.
- White cards.
- Deep blue text.
- Coral primary actions.
- Soft shadows and clear borders.

Dark theme:

- Deep navy, never pure black.
- Lighter navy cards.
- Warm cream text.
- Steel-blue supporting text.
- Coral primary actions.
- Subtle borders and reduced shadow.

Both themes must use identical layouts, content hierarchy, spacing, and component sizes.

## Photography rules

Copy the curated images from `photos/` into the project's existing asset structure with safe filenames. Add them to the service-worker precache if the current caching strategy requires it.

- Use only these real club photos.
- Use shallow header crops or restrained background treatments.
- Keep photos below 16 percent of the mobile viewport height on data-heavy pages.
- Community media is the exception because media is user-facing content there.
- Never place long text, metrics, inputs, or primary controls directly on busy photography.
- Add a navy overlay in dark mode.
- Use responsive `object-fit: cover`, stable aspect ratios, explicit dimensions, and lazy loading where appropriate.
- Optimize image delivery without visibly degrading quality.

## Required screen work

Apply one shared component system across:

1. Record and edit workout, including exercise picker, set rows, totals, notes, save action, empty states, edit states, and validation states.
2. Workout history, including search, filters, grouped dates, PR markers, and detail navigation.
3. Calendar, including month navigation, category markers, legend, selected day, and workout detail.
4. Progress and PRs, including exercise selector, summary cards, one readable chart, and PR table.
5. Workout library and custom workout builder.
6. Community, including club announcements, feed cards, reactions, comments, leaderboard preview, signed-out state, empty state, and moderation affordances already present in the product.
7. Achievements and notifications, including unlocked, locked, unread, and empty states.
8. Settings and onboarding, including theme, accessibility, data, community connection, about, destructive actions, and install or update prompts.
9. Navigation menu, modal sheets, confirmation dialogs, loading states, error states, success states, and offline states.
10. Desktop layouts using the same system, without creating desktop-only features.

## Implementation sequence

Work in small verified stages:

1. Inventory current screens, hooks, and tests. Produce a concise implementation map.
2. Add or refine global tokens, typography, spacing, surfaces, focus states, and theme parity.
3. Add optimized club photo assets and shared photo-header components.
4. Update global navigation, headers, cards, buttons, inputs, modals, and empty states.
5. Implement the eight screen families one at a time.
6. Verify mobile, installed PWA, safe areas, keyboard behavior, desktop breakpoints, RTL, light mode, dark mode, offline mode, and reduced motion.
7. Run the full existing test suite, accessibility checks, browser checks, linting, and build validation after each safe stage.
8. Fix regressions before continuing.

## Quality bar

- The purpose of every screen must read within two seconds.
- The interface must feel welcoming after a hard workout.
- Photography must identify the club without competing with the task.
- One primary action per screen.
- No ornamental element without a clear role.
- No visual change should weaken usability, accessibility, reliability, security, or offline behavior.

Before editing, report the exact files you plan to change and any conflicts between the mockups and current behavior. Then implement the redesign. Do not stop after producing a plan. Complete each stage, test it, and summarize verified results and remaining risks.
