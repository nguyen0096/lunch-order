-- An office words its own order to the caterer.
--
-- The message on the Menu screen was a literal in the web app, so an office
-- that greets its caterer, signs off, or names itself had to retype it every
-- day. It is now a template with placeholders the app fills in. Null means the
-- app's default wording, so nothing is seeded and an office that never opens
-- the editor sees the message it always had.
--
-- The check is the enforcement; the editor mirrors it only to say which rule
-- was broken. Without `{dishes}` the caterer is not told what to cook, and a
-- misspelt placeholder such as `{dish}` would reach the caterer as literal
-- text, so both are refused here rather than trusted to the screen.
--
-- Written with the plain UPDATE the other office settings use: authenticated
-- holds UPDATE on organizations and `organizations_update_admin` narrows it to
-- an admin's own office.

alter table public.organizations
  add column if not exists caterer_message_template text;

alter table public.organizations
  drop constraint if exists organizations_caterer_message_template_ck;
alter table public.organizations
  add constraint organizations_caterer_message_template_ck check (
    caterer_message_template is null or (
      length(caterer_message_template) <= 2000
      and position('{dishes}' in caterer_message_template) > 0
      and regexp_replace(
            caterer_message_template,
            '\{(companyName|servingDate|dishes|total|unchosen)\}', '', 'g'
          ) !~ '\{[A-Za-z_]+\}'
    )
  );

comment on column public.organizations.caterer_message_template is
  'The order sent to the caterer, with {companyName} {servingDate} {dishes} {total} {unchosen}. Null means the app default.';
