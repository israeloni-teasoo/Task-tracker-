-- Let any signed-in user read colleague profiles (names/emails) so comment
-- authors, assignees and recipients render as real names everywhere — not
-- "Staff"/"Someone". (Names are already exposed via public_staff.) Idempotent.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (auth.uid() is not null);
