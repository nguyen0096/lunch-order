-- A short code made of initials, not the first four letters of a name.
--
-- The code appears in a bank transfer memo and beside somebody's name on the
-- People screen, and it was `left(full_name, 4)`: "Quy Tu Nguyen" became QUYT.
-- A four-letter prefix of a real name is a coin flip on spelling a word, and in
-- Vietnamese the words it lands on are not always ones you would put next to a
-- colleague's name.
--
-- Initials are not immune -- any short string can spell something -- but they
-- are far less likely to, and they read as a reference rather than as an
-- attempt at a word: QTN, DNN, NND.
--
-- Existing codes are left exactly as they are. This only decides what a new
-- member is offered, and Settings now lets anybody change their own, which is
-- the real answer: the person whose name it is knows whether it landed badly.
create or replace function private.suggest_short_code(p_org_id bigint, p_profile_id uuid)
returns text
language plpgsql
stable
set search_path to ''
as $fn$
declare v_src text; v_words text[]; v_base text; v_try text; v_n int := 0;
begin
  select public.unaccent_fallback(
           coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)))
    into v_src
    from public.profiles p where p.id = p_profile_id;

  v_words := array_remove(
    regexp_split_to_array(
      upper(regexp_replace(coalesce(v_src, ''), '[^A-Za-z0-9]+', ' ', 'g')), '\s+'),
    '');

  if array_length(v_words, 1) >= 2 then
    -- First letter of up to four words. More than four is a long name, and a
    -- memo is not the place to reproduce all of it.
    select string_agg(left(w, 1), '') into v_base
      from unnest(v_words) with ordinality as t(w, i)
     where i <= 4;
  else
    -- One word is all there is, so a prefix is the only option left. Three
    -- rather than four: shorter is less likely to be a word.
    v_base := left(coalesce(v_words[1], ''), 3);
  end if;

  v_base := coalesce(nullif(left(v_base, 4), ''), 'USER');
  -- The column requires at least two characters, and a one-word one-letter
  -- name would otherwise fail the CHECK rather than the person.
  if length(v_base) < 2 then v_base := rpad(v_base, 2, 'X'); end if;

  loop
    v_try := case when v_n = 0 then v_base else left(v_base, 3) || v_n::text end;
    exit when not exists (select 1 from public.memberships m
                           where m.org_id = p_org_id and m.short_code = v_try);
    v_n := v_n + 1;
    if v_n > 999 then raise exception 'could not allocate a short code'; end if;
  end loop;
  return v_try;
end
$fn$;
