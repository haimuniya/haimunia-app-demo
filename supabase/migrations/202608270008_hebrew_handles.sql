begin;

-- Handles were English-letters-only (a-z0-9_) — a real friction point for
-- a Hebrew-speaking membership typing on a Hebrew keyboard. Widen to also
-- accept Hebrew letters (א-ת), keeping the same length bound and the same
-- ban on spaces/punctuation (still a compact identifier, not free text —
-- display_name already covers full free-form names).
alter table public.profiles drop constraint profiles_handle_check;
alter table public.profiles add constraint profiles_handle_check check (handle ~ '^[a-zא-ת0-9_]{3,24}$');

commit;
