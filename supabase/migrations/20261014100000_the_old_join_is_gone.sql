-- The four-argument join_with_code is dropped.
--
-- 20261013100000 kept public.join_with_code(p_code, p_display_name, p_chat_id,
-- p_short_code) for bundles and bot builds deployed before it. It refused any
-- chat and otherwise did what the three-argument join does. Both the SPA and
-- the telegram function from that change are now what is deployed, and the bot
-- binds a chat only through private.join_office_with_code, so nothing calls it.
--
-- The three-argument public.join_with_code(p_code, p_display_name,
-- p_short_code) is the browser's door and stays.

drop function if exists public.join_with_code(text, text, bigint, text);
