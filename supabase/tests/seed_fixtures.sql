-- Two orgs, three people, one shared service date. Enough to prove tenant
-- isolation and the recipient-pays billing rule. Test data only.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','authenticated','authenticated','anh@orga.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Anh Nguyễn"}'),
 ('00000000-0000-0000-0000-000000000000','22222222-2222-2222-2222-222222222222','authenticated','authenticated','binh@orga.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bình Trần"}'),
 ('00000000-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333','authenticated','authenticated','chi@orgb.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Chi Lê"}')
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, default_cutoff_local_time)
values ('org-a','Org A','Asia/Ho_Chi_Minh','16:00'),
       ('org-b','Org B','Asia/Ho_Chi_Minh','16:00')
on conflict do nothing;

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid, u.role, u.code from public.organizations o
join (values
  ('org-a','11111111-1111-1111-1111-111111111111'::uuid,'owner','ANH'),
  ('org-a','22222222-2222-2222-2222-222222222222'::uuid,'member','BINH'),
  ('org-b','33333333-3333-3333-3333-333333333333'::uuid,'owner','CHI')
) as u(slug,pid,role,code) on u.slug = o.slug
on conflict do nothing;

insert into public.menus (org_id, service_date, order_cutoff_at, created_by, source_text)
select o.id, current_date + 3,
       ((current_date + 2)::timestamp + time '16:00') at time zone o.timezone,
       m.profile_id, 'seed'
from public.organizations o
join public.memberships m on m.org_id = o.id and m.role = 'owner'
where o.slug in ('org-a','org-b')
on conflict do nothing;

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select mu.id, mu.org_id, v.name, v.price, v.pos
from public.menus mu
join public.organizations o on o.id = mu.org_id and o.slug in ('org-a','org-b')
join lateral (values ('Cơm gà xối mỡ', 45000, 0), ('Bún bò Huế', 40000, 1))
     as v(name, price, pos) on true
on conflict do nothing;
