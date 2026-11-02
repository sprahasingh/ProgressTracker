begin;
select plan(7);

select ok(public.tracker_milestones_are_append_only(
  '[{"id":"old","title":"Original","description":"","position":0}]'::jsonb,
  '[{"id":"old","title":"Original","description":"","position":0},{"id":"new","title":"New","description":"","position":1}]'::jsonb
), 'a unique new milestone may be appended');

select ok(public.tracker_milestones_are_append_only('[]'::jsonb,
  '[{"id":"new","title":"New","description":"","position":0}]'::jsonb), 'addition works when the saved tracker had no milestones');

select ok(public.tracker_milestones_are_append_only(
  '[{"id":"old","title":"Original","description":"","position":0}]'::jsonb,
  '[{"id":"old","title":"Original","description":"","position":0}]'::jsonb
), 'unchanged definitions remain valid');

select ok(not public.tracker_milestones_are_append_only(
  '[{"id":"old","title":"Original","description":"","position":0}]'::jsonb,
  '[{"id":"old","title":"Changed","description":"","position":0}]'::jsonb
), 'existing requirement edits are rejected');

select ok(not public.tracker_milestones_are_append_only(
  '[{"id":"old","title":"Original","description":"","position":0}]'::jsonb, '[]'::jsonb
), 'removing an existing requirement is rejected');

select ok(not public.tracker_milestones_are_append_only('[]'::jsonb,
  '[{"id":"new","title":"One","description":"","position":0},{"id":"new","title":"Two","description":"","position":1}]'::jsonb
), 'duplicate IDs are rejected');

select ok(public.tracker_milestones_are_append_only(
  '[{"id":"old","title":"Original","description":"","position":0},{"id":"old","title":"Legacy duplicate","description":"","position":1}]'::jsonb,
  '[{"id":"old","title":"Original","description":"","position":0},{"id":"old","title":"Legacy duplicate","description":"","position":1},{"id":"new","title":"New","description":"","position":2}]'::jsonb
), 'unchanged legacy duplicate IDs do not prevent an unrelated unique addition');

select * from finish();
rollback;
