# Migration rehearsal against existing data

Everything else in this audit verified the schema by building it **from an
empty database** (`supabase db reset`). That is not the operation
`supabase db push` performs on your production project. Push applies the
pending migrations **on top of rows that already exist** — and six of this
release's statements are FK re-adds that VALIDATE against those rows:

```
alter table public.invites drop constraint invites_created_by_fkey;
alter table public.invites add constraint invites_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;
```

If a single existing row violates one, `db push` aborts partway through.
A clean-slate test can never surface that. This document records the
rehearsal that closes the gap.

## Method

1. Rolled a local database back to the **pre-release schema** (the 101
   migrations that production currently has).
2. Seeded realistic data, deliberately including the shapes a long-lived
   project accumulates and an empty database cannot produce:
   - a per-person invite created by one member and redeemed by another
   - a report already reviewed, with `reviewed_by` set
   - `onboarding_step_content` / `intro_carousel_content` rows carrying
     `updated_by`
   - a removed (soft-deleted) post alongside live ones
   - attendance rows, announcements
   - a `private_records` payload of ~90,000 characters, written **before**
     the new size cap existed
3. Applied the 7 pending migrations with `supabase migration up` — the same
   operation `db push` performs.

## Result 1 — the finding was real, and worse than "theoretical"

On the **current production schema**, deleting a member who had ever created
a per-person invite:

```
DELETE BLOCKED -> 23503
  violates foreign key constraint "invites_created_by_fkey" on table "invites"
```

So DB-H2 was not a latent tidiness issue. Any member who ever issued an
invite **could not be purged at all**, and `purge_due_accounts()` deletes in
a single bulk statement — so one such member would have aborted the purge
for **everyone** in that batch. The 30-day deletion promise in `PRIVACY.md`
would have failed silently and permanently.

## Result 2 — all 7 migrations apply cleanly onto existing data

```
Applying 202609060011 … 202609060017    Migrations applied    exit 0
```

No FK validation failure, no constraint violation, no aborted transaction.

## Result 3 — data survived intact, and references nulled rather than cascaded

| | before | after |
|---|---:|---:|
| profiles | 3 | 3 |
| invites | 2 | 2 |
| reports | 1 | 1 |
| workout_posts | 5 | 5 |
| private_records | 1 | 1 |

After purging the member, with the fix in place:

```
DELETE SUCCEEDED - the purge is unblocked
invites surviving: 2  (created_by null: 1)
reports surviving: 1  (reviewed_by null: 1)
```

This is the property `ON DELETE SET NULL` was chosen for over `CASCADE`:
the invite and the moderation record **outlive the account**, losing only
the attribution. Cascade would have destroyed a still-valid invite and a
report's review history along with the member.

## Result 4 — the payload cap grandfathers legacy rows, as designed

The ~90,000-character `private_records` row written before the cap existed
**survived** the migration, because the constraint is added `NOT VALID`.
New writes are still refused:

| write | result |
|---|---|
| legacy row, pre-existing | still present after migration |
| new 100,000-char payload | refused, `23514` |
| new 80 KB **incompressible** payload | refused |

### One nuance worth knowing before running `VALIDATE CONSTRAINT`

`pg_column_size()` returns the **TOAST-compressed** size of a stored value.
The seeded row measures 90,009 raw JSON characters but only **1,055 bytes**
stored. The CHECK still works on insert — constraints are evaluated on the
in-memory tuple *before* compression, which is why both new-write cases
above are refused — but it means:

- the cap is effectively "64 KB of *stored* bytes", which is the right
  measure for bounding database growth, and more generous than "64 KB of
  JSON" for compressible data;
- the follow-up `alter table public.private_records validate constraint
  private_records_payload_size;` suggested in `202609060012` will likely
  **succeed** even against legacy rows, because it re-checks the stored
  (compressed) size. Run it and see rather than assuming it will fail.

## What this does and does not prove

**Proves:** the migrations are safe to apply to a database that already has
data of the shapes above, and the FK fix delivers the behaviour change it
was written for.

**Does not prove:** anything about your production data specifically. This
used representative synthetic rows, not a copy of the real project. If
production contains a shape not modelled here, `db push` could still
surface it. That is why `LAUNCH_CHECKLIST.md` says to take
`supabase db dump` first — the rehearsal lowers the risk, the backup is
what makes a surprise recoverable.
