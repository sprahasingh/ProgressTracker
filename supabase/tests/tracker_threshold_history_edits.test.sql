begin;
select plan(8);

select is(
  public.tracker_edit_metrics_without_thresholds('[{"id":"pages","name":"Pages","valueType":"quantity","unit":"pages","thresholds":{"direction":"increase","target":5}}]'::jsonb),
  '[{"id":"pages","name":"Pages","valueType":"quantity","unit":"pages"}]'::jsonb,
  'measure structure comparison removes only threshold policy'
);
select is(
  public.tracker_edit_metrics_without_thresholds('[{"id":"pages","name":"Pages","valueType":"quantity","unit":"pages","thresholds":{"direction":"decrease","target":2}}]'::jsonb),
  public.tracker_edit_metrics_without_thresholds('[{"id":"pages","name":"Pages","valueType":"quantity","unit":"pages","thresholds":{"direction":"increase","target":5}}]'::jsonb),
  'threshold values and direction do not change measure structure'
);
select isnt(
  public.tracker_edit_metrics_without_thresholds('[{"id":"pages","name":"Pages","valueType":"quantity","unit":"chapters","thresholds":{"direction":"increase","target":5}}]'::jsonb),
  public.tracker_edit_metrics_without_thresholds('[{"id":"pages","name":"Pages","valueType":"quantity","unit":"pages","thresholds":{"direction":"increase","target":5}}]'::jsonb),
  'unit changes remain structural'
);
select ok(position('tracker_edit_metrics_without_thresholds' in pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure)) > 0,
  'the existing sync guard distinguishes threshold changes from structural changes');
select is(
  public.tracker_edit_evaluation_without_thresholds('{"metrics":[{"id":"pages","thresholds":{"direction":"increase","target":5}}],"qualificationRule":{"kind":"threshold","metricId":"pages"}}'::jsonb),
  public.tracker_edit_evaluation_without_thresholds('{"metrics":[{"id":"pages","thresholds":{"direction":"decrease","target":2}}],"qualificationRule":{"kind":"threshold","metricId":"pages"}}'::jsonb),
  'threshold direction and value changes compare as policy-only evaluation edits'
);
select isnt(
  public.tracker_edit_evaluation_without_thresholds('{"metrics":[{"id":"pages","thresholds":{"direction":"increase","target":5}}],"qualificationRule":{"kind":"threshold","metricId":"pages"}}'::jsonb),
  public.tracker_edit_evaluation_without_thresholds('{"metrics":[{"id":"pages","thresholds":{"direction":"increase","target":5}}],"qualificationRule":{"kind":"comparison","metricId":"pages"}}'::jsonb),
  'non-threshold rule changes remain distinguishable for milestone safeguards'
);
select ok(position('tracker_edit_evaluation_without_thresholds' in pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure)) > 0,
  'historical milestone safeguards remain for changes beyond threshold policy');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select is(public.tracker_edit_sync_guards_contract(),'tracker-edit-sync-guards:v2'::text,
  'clients can require the threshold-aware sync guard before cloud upload');

select * from finish();
rollback;
