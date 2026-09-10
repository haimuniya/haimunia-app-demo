begin;

-- Launch-readiness re-audit, 2026-09-10, RISK_REGISTER.md AUDIT0827-PROD-3
-- (open since 2026-08-27): neither the onboarding modal nor the Community
-- intro carousel ever told a new member what happens to their data once
-- they join - PRIVACY.md exists and is linked from Settings, but nothing
-- sits before community sign-in.
--
-- THE FIX. One sentence added to the 'club_rules' step of the three-screen
-- intro carousel (202609050007) - the step already covering club policy
-- facts (hours, dress code, cancellations), so a data-visibility fact
-- belongs there rather than as a fourth screen (the table's own CHECK
-- constraint fixes the step set at exactly three; adding a screen would be
-- a bigger, riskier schema change for a one-sentence gap).
--
-- THE COPY IS ACCURATE TO PRIVACY.md's ACTUAL DEFAULTS, not a vague
-- overstatement: "my profile visible to club members" defaults ON,
-- "workout results visible" / "personal records visible" / "attendance
-- visible" all default OFF (PRIVACY.md:611-621). So the honest sentence is
-- "your profile is visible by default, your numbers are not and only
-- publish when you choose to" - not "everything becomes public."
--
-- GUARDED UPDATE, not a blind one: only touches the row if its body still
-- matches the original seed text byte-for-byte. A club that already
-- customized this step's copy through the admin content editor
-- (renderIntroCarouselContentEditor, cloud.js) keeps its own words -
-- this migration adds a fact to the default copy, it does not overwrite a
-- staff edit sight-unseen.
--
-- WHY THIS IS NOT A BREAKING CHANGE: title/body are freely-editable text
-- columns already read as plain strings by renderIntroCarousel() (cloud.js)
-- - no schema, RLS, or client-code change, so nothing consuming this table
-- needs to change shape.
--
-- ROLLBACK is a one-line UPDATE back to the original seed text below.
update public.intro_carousel_content
set body = 'שעות הפעילות, קוד הלבוש, כללי הציוד האישי ומדיניות הביטולים - כל המידע הזה זמין תמיד בלשונית הקהילה. הפרופיל שלכם גלוי לחברי המועדון כברירת מחדל, אבל תוצאות אימונים, שיאים ונוכחות נשארים פרטיים עד שתבחרו לשתף אותם - את זה אפשר לשנות בכל רגע בהגדרות › פרטיות.'
where step = 'club_rules'
  and body = 'שעות הפעילות, קוד הלבוש, כללי הציוד האישי ומדיניות הביטולים - כל המידע הזה זמין תמיד בלשונית הקהילה.';

commit;
